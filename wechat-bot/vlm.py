"""
视觉模型感知层：把截图交给多模态模型读文字。

为什么不用 Windows OCR：实测它对微信的小字号不可靠 —— 聊天标题区读不出任何
文字，会话列表把「消息预览」当成「会话名」（把 G 那条会话的预览『你是谁』
当成了会话名，而该会话的真名就是一个字母 G），输入框回读把文字读得支离破碎。

**未读角标绝不交给模型判断**：实测模型会凭空说某行「有红色未读圆点」，
而那一行连一个品牌红像素都没有。未读判定只走 layout.detect_badges 的像素判据。

模型有随机性：同一张裁剪图，上一次能读出标题、这一次说「看不清」。所以
  - 裁剪要给足上下文（窄条/过小的裁剪更容易翻车），标题与消息合成一次调用
  - 读不出来要重试，重试仍失败就返回失败让调用方 abort，绝不猜

代价：截图会发到模型服务商。这是视觉方案的固有成本。
"""

import base64
import io
import json
import re
import time
import urllib.error
import urllib.request

VL_MODEL = "Qwen/Qwen3-VL-30B-A3B-Instruct"

CHAT_PANE_PROMPT = (
    "这是微信电脑版的右侧聊天栏。按下面的格式输出：\n"
    "第一行回答当前会话名，格式「会话名：x」；\n"
    "第二行回答「类型：私聊」或「类型：群聊」；\n"
    "之后每行一条消息，格式「左: 内容」或「右: 内容」。\n"
    "微信里靠左的气泡是对方发的，靠右的是我自己发的。"
    "消息按时间从早到晚，最多 6 条。底部输入框里的文字不算消息。"
)

# 换一种问法交替重试：模型对措辞敏感，同一张图换个说法常常就出来了。
CHAT_PANE_PROMPT_SIMPLE = (
    "这是微信的右侧聊天栏。第一行回答当前会话名（格式「会话名：x」），"
    "然后每行一条消息「左: 内容」或「右: 内容」"
    "（靠左的气泡是对方发的，靠右的是我自己发的）。"
    "另外单独一行写「类型：私聊」或「类型：群聊」。按时间从早到晚，最多 6 条。"
)

# 注意：**主提示词里不要写「看不清就写看不清」**。
# 实测那句话会把模型教懒 —— 同一张图，带这句时返回「标题: 」空值加一串
# 「看不清」，去掉这句就正常读出会话名和消息。要它承认读不出来，用这个
# 兜底提示词单独问。
TITLE_ONLY_PROMPT = (
    "这是微信聊天窗口顶部的会话标题栏。只回答当前会话的名字原文，"
    "不要加任何其它字。看不清就只回答「看不清」，不要猜。")

# 群聊标题形如「摸鱼集团(5)」，括号里是人数。模型偶尔不填「类型」，
# 用它兜底判型（原项目 parse_title 的判据）。
_GROUP_SUFFIX = re.compile(r"[（(]\s*\d+\s*[)）]\s*$")


def _ask(cfg, prompt, img, model=None, max_tokens=500, timeout=150):
    """调一次多模态模型。

    超时给到 150 秒：实测同一个接口同一张图，闲时 1.4 秒、忙时 39.8 秒。
    之前设 90 秒，忙的时候连读会话名都三次全超时，机器人就报「读不到标题」
    直接中止 —— 看起来像功能坏了，其实只是接口在排队。
    """
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    body = json.dumps({
        "model": model or VL_MODEL,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url",
             "image_url": {"url": f"data:image/png;base64,{b64}"}},
        ]}],
        "max_tokens": max_tokens,
        "temperature": 0.0,
    }).encode("utf-8")
    req = urllib.request.Request(
        cfg["baseUrl"] + "/chat/completions", data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + cfg["apiKey"]})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return None, f"HTTP {exc.code}: {exc.read()[:200].decode('utf-8', 'replace')}"
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"
    try:
        return data["choices"][0]["message"]["content"].strip(), ""
    except Exception:
        return None, str(data)[:200]


def _clean_name(s):
    """模型爱加序号、引号、时间、冒号，剥掉。"""
    t = s.strip().strip("「」\"'“”*`")
    for sep in ("：", ":"):
        if sep in t:
            t = t.split(sep, 1)[0]
    t = t.split("|")[0].split("｜")[0]
    return t.strip().strip("「」\"'“”")


def _bad_name(t):
    return (not t) or ("看不清" in t) or len(t) > 40


def _bad_msg(t):
    """「看不清」这类占位不是消息，必须丢掉。

    漏掉这一步的话，模型吐 6 条「看不清」会被当成 6 条真实消息，解析器判
    「有消息」放行，然后拿着「看不清」去生成回复。
    """
    t = t.strip().strip("「」\"'“”*`")
    return (not t) or ("看不清" in t) or t in ("...", "…", "无", "略")


def _side_of(line):
    """识别「左: / 右: / 对方: / 我: 」前缀，返回 ('左'|'右', 内容) 或 (None, line)。"""
    for tag in ("左", "右", "对方", "我"):
        for sep in ("：", ":"):
            if line.startswith(tag + sep):
                return ("右" if tag in ("右", "我") else "左",
                        line[len(tag) + 1:].strip())
    return None, line


def parse_chat_pane(text):
    """解析「标题 / 类型 / 左|右: 内容」。

    返回 (标题, [('左'|'右', 内容), ...], 是否群聊)。

    严格：只认带左右标注的消息行。模型对昵称的标注不稳定（同一条消息一会标
    「我」一会标「你」），所以只认气泡左右位置 —— 微信里靠左是对方、靠右是我。
    没有标注就返回空列表让调用方重试，**绝不替它猜成「对方发的」**，否则会把
    自己刚说的话当成来信，回自己一句。
    """
    title, msgs, is_group = None, [], None
    saw_title_label = False
    lines = [l.strip().lstrip("-•*` ").strip() for l in text.splitlines()]
    for line in (l for l in lines if l):
        low = line.replace(" ", "")
        if low.startswith("类型"):
            v = line.split("：", 1)[-1].split(":", 1)[-1].strip()
            if "群" in v:
                is_group = True
            elif v:
                is_group = False
            continue
        if title is None and (low.startswith("标题") or low.startswith("会话名")):
            saw_title_label = True
            v = line.split("：", 1)[-1].split(":", 1)[-1].strip()
            if v:
                title = v
            continue
        if low.startswith(("消息", "最后")) and len(line) <= 8:
            continue
        side, content = _side_of(line)
        if side and not _bad_msg(content):
            msgs.append((side, content))
    if title is None and not saw_title_label and lines:
        title = _clean_name(lines[0])
    if is_group is None and title:
        is_group = bool(_GROUP_SUFFIX.search(title))
    return title, msgs, bool(is_group)


def read_session_name(img, badge, region, cfg, model=None, retries=2):
    """读带未读角标那一行的会话名。只裁那一行，最小化外传内容。

    badge 是整窗坐标的红圈框。行内布局：名字在行顶下方约 20px，
    红圈压在头像左上角（即行顶附近），所以上下各留一段。
    """
    left, _, right, _ = region
    top = max(0, badge[1] - 25)
    crop = img.crop((left, top, right, badge[3] + 55))
    prompt = ("这是微信会话列表里的一行。只回答这一行的联系人/群名原文，"
              "不要回答消息预览的内容，不要加任何其它字。"
              "看不清就只回答「看不清」，不要猜。")
    last = ""
    for _ in range(retries + 1):
        out, err = _ask(cfg, prompt, crop, model=model, max_tokens=60)
        if not out:
            last = err
            continue
        name = _clean_name(out)
        if not _bad_name(name):
            return name, ""
        last = f"模型说看不清（原文 {out!r}）"
    return None, last


def read_title_band(img, snap, cfg, model=None, retries=1):
    """只裁标题带问一次。

    用在「消息读到了、只差标题」的时候：比整栏重问便宜，而且标题这种短文本
    在窄条上往往更准（整栏裁剪里它只占很小一块，容易被模型忽略）。
    """
    x1, y1, x2, y2 = snap.regions["title"]
    pad = int(10 * snap.k)
    crop = img.crop((max(0, x1 - int(60 * snap.k)), max(0, y1 - pad),
                     min(snap.rect[2], x2), min(snap.rect[3], y2 + pad)))
    last = ""
    for _ in range(retries + 1):
        out, err = _ask(cfg, TITLE_ONLY_PROMPT, crop, model=model, max_tokens=60)
        if not out:
            last = err
            continue
        name = _clean_name(out)
        if not _bad_name(name):
            return name, ""
        last = f"模型说看不清（原文 {out!r}）"
    return None, last


def read_chat_pane(img, snap, cfg, model=None, retries=2):
    """一次读回「聊天标题 + 类型 + 最后几条消息」。

    返回 (info, 错误)。info = {"title", "msgs", "group"}，失败时 info 为 None。

    标题和消息合成一次调用：模型在信息完整的裁剪上更稳，而且省一次往返。
    裁剪取整条聊天栏（含窗口标题栏下方到输入框上沿），给足上下文 ——
    实测窄条裁剪（如只有标题那 50px）会随机读不出来。

    消息读到了、只有标题读不到时，会单独裁标题带再问一次，而不是整栏重问：
    实测模型经常给出消息但把标题留空，整栏重问三次都空，单独问窄条就出来了。
    """
    mx1, _, mx2, my2 = snap.regions["message"]
    left = max(0, mx1 - int(90 * snap.k))
    top = max(0, int(20 * snap.k))
    bottom = min(snap.rect[3], my2 + int(60 * snap.k))
    crop = img.crop((left, top, mx2, bottom))
    last = ""
    best_msgs = None
    prompts = (CHAT_PANE_PROMPT, CHAT_PANE_PROMPT_SIMPLE)
    for i in range(retries + 1):
        out, err = _ask(cfg, prompts[i % len(prompts)], crop, model=model,
                        max_tokens=500)
        if not out:
            last = err
            continue
        title, msgs, is_group = parse_chat_pane(out)
        if title and not _bad_name(title) and msgs:
            return {"title": title, "msgs": msgs, "group": is_group}, ""
        if msgs and best_msgs is None:
            best_msgs = (msgs, is_group)
        last = f"解析不出（原文 {out[:150]!r}）"

    if best_msgs:
        title, terr = read_title_band(img, snap, cfg, model)
        if title:
            return {"title": title, "msgs": best_msgs[0],
                    "group": best_msgs[1]}, ""
        last = f"{last}；标题带单独读也失败：{terr}"
    return None, last


def read_input_box(img, region, cfg, model=None, retries=1):
    """读聊天输入框里已经打好的文字。

    空白输入框会显示灰色占位提示（「按住鼠标语音输入文字」），那种情况
    必须返回空串 —— 否则会把占位提示当成「输入成功了」。
    """
    left, top, right, bottom = region
    crop = img.crop((left, top, right, bottom))
    prompt = ("这是微信聊天窗口底部的输入框。只回答输入框里用户已经打好的文字"
              "原文；如果输入框是空的（只有灰色占位提示，例如"
              "「按住鼠标语音输入文字」），就只回答一个字「空」。"
              "不要加任何其它字，不要加引号。")
    last = ""
    for _ in range(retries + 1):
        out, err = _ask(cfg, prompt, crop, model=model, max_tokens=300)
        if not out:
            last = err
            continue
        t = out.strip().strip("「」\"'“”`")
        if t in ("空", "空。", "无", "没有", "empty", ""):
            return "", ""
        if "看不清" in t:
            last = f"模型说看不清（原文 {out!r}）"
            time.sleep(0.3)
            continue
        return t, ""
    return None, last
