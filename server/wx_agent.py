#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
微信 Linux 版自动回复代理（容器内运行）。

流程：
  循环 {
    1. 截左侧会话列表 → 与上次比对，变化才继续
    2. 在列表里找"未读红点"（红色像素按行聚类）
    3. 点击该会话行 → 等待打开
    4. 截聊天区 → OCR → 提取最后一条对方消息 + 会话名
    5. 白名单校验 → 频率/去重护栏 → 调 LLM 生成回复
    6. 点击输入框 → 清空 → 粘贴回复 → 回车
  }

依赖：xdotool xclip import(ImageMagick) tesseract-ocr-chi-sim python3-pil python3-requests
配置：/tmp/wx_agent_cfg.json   状态：/tmp/wx_agent_state.json   日志：stdout
"""
import json, os, re, subprocess, time, hashlib, sys, random, difflib
import ctypes
from concurrent.futures import ThreadPoolExecutor
from PIL import Image

DISPLAY = ':99'
# 和 QQ 共用的素材池：pics/ 387 张梗图、voice/ 语音缓存、library.json 索引。
# 由宿主机 rsync 从 /opt/secretary/.data/media 同步到 /opt/linux-im/media
# （微信容器只挂载了 /data，Docker 不支持给运行中的容器加挂载）。
MEDIA = '/data/media'
# tesseract 自带 OpenMP 多线程，但机器只有 2 核：让它单线程反而更快
# （实测「标题+正文」两次 OCR 从 1021ms 降到 900ms，输出逐字一致）。
# 必须写进 ENV，ocr() 起子进程时会继承。
ENV = dict(os.environ, DISPLAY=DISPLAY, OMP_THREAD_LIMIT='1')
os.environ['OMP_THREAD_LIMIT'] = '1'

# ---------- 配置 ----------

DEFAULT_CFG = {
    # 只收不发的监听模式：全量接收并归档（含图片/表情/语音/视频的类型标注与截图），
    # 绝不调用模型回复、绝不发送任何消息。和 QQ 的 qq.observeOnly 是同一个语义。
    # 开启后白名单/群聊过滤/冷却/限速全部旁路——「处理所有信息」不该有过滤。
    'observeOnly': False,
    # 白名单：会话名（OCR 出来的）精确/包含匹配。空列表 = 不回复任何人
    'whitelist': [],
    # 拟人停顿。原来 2~6s 纯属空转，聊天气泡不是打字机，0.25~0.6s 已经像人在敲
    # 拟人停顿。原来 0.4~1.2s 是「像人在打字」，但要压到 1 秒内响应，
    # 这 0.4s 就成了纯负担。0.05~0.15s 仍有一点抖动，不像机器零点几毫秒卡点。
    'replyMinDelay': 0.05,
    'replyMaxDelay': 0.15,
    # 空闲轮询间隔。**感知延迟 = 轮询间隔 + 处理耗时**，内部优化得再好，
    # 等 0.8s 才发现新消息也是白搭。XGetImage 只抓 246x680 的条带（4.8ms）
    # 加红点检测（4ms），一个 tick 才 9.2ms，0.3s 间隔约 3% CPU，负担得起。
    'pollInterval': 0.3,
    # 同一会话两次回复最小间隔。原来是 20s，但冷却期内的消息现在改成
    # 「原地等冷却走完再回」而不是丢弃，等 20 秒太久，压到 8 秒：
    # 对方连发两句仍能收到两条回复，间隔也够像人在打字。
    'sessionCooldown': 2.5,
    'maxPerHour': 80,             # 每小时回复上限（防失控，不是防聊天）
    'llm': {
        'baseUrl': 'https://api.siliconflow.cn/v1',
        'model': 'deepseek-ai/DeepSeek-V4.1-Flash',
        'apiKey': '',            # 必填
        # 人设只有这一个来源（cfg 里不要再写一份，否则旧文本会盖住这里）。
        # 抽象指令「15 字以内」模型基本不听：实测 10 条里 8 条尾巴挂着反问
        # （你呢？/咋啦？），一句被撑成两句。改成 few-shot 给样子——
        # 「show, don't tell」是各家文档的共识，示例比形容词管用得多。
        'persona': (
            '你在微信上和一个朋友聊天，你就是你自己，不是助手。\n'
            '规则：\n'
            '1. 一次只回一句话，5~10 个字最好，绝对不超过 15 个字。\n'
            '2. 结尾不加句号。不用 markdown、不用列表、不加引号、不加表情符号。\n'
            '3. 大多数时候只是回应对方，不要每句都反问。真的想知道才问，问了也要短。\n'
            '4. 不说教、不总结、不客套，不像客服。\n'
            '\n'
            '对方：你晚上一般几点睡啊\n你：十二点吧\n\n'
            '对方：在吗\n你：在呢\n\n'
            '对方：今天好累啊\n你：咋了\n\n'
            '对方：周末有空吗\n你：应该有\n\n'
            '对方：推荐部电影呗\n你：想看啥类型的\n\n'
            '对方：你吃饭了没\n你：刚吃完\n\n'
            '对方：我先睡了\n你：晚安\n\n'
            '对方：哈哈哈哈笑死\n你：啥事这么好笑\n'
        ),
    },
    'history': {}                # 会话名 -> 最近消息文本（上下文）
}

# 配置与状态优先放 /data（宿主机 /opt/linux-im 的挂载点），容器重建也不丢；
# /tmp 是早期位置，保留作回退。
def _pick(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return paths[0]

CFG_PATH = _pick([os.environ.get('WX_AGENT_CFG', ''), '/data/wx_agent_cfg.json',
                  '/tmp/wx_agent_cfg.json'])
STATE_PATH = os.environ.get('WX_AGENT_STATE') or (
    '/data/wx_agent_state.json' if os.path.isdir('/data') else '/tmp/wx_agent_state.json')

def load_cfg():
    cfg = dict(DEFAULT_CFG)
    if os.path.exists(CFG_PATH):
        try:
            user = json.load(open(CFG_PATH))
            # llm 要**深合并**：cfg 文件里只要写了 llm 对象，浅 update 会把
            # 默认的 persona 整个抹掉，llm_reply 立刻 KeyError。踩过。
            llm = dict(cfg.get('llm') or {})
            llm.update(user.get('llm') or {})
            cfg.update(user)
            cfg['llm'] = llm
        except Exception as e:
            log('cfg load fail: %s' % e)
    return cfg

def load_state():
    if os.path.exists(STATE_PATH):
        try:
            return json.load(open(STATE_PATH))
        except Exception:
            pass
    return {'lastReply': {}, 'hourStart': 0, 'hourCount': 0, 'seenDigest': {}}

def save_state(st):
    json.dump(st, open(STATE_PATH, 'w'), ensure_ascii=False)

def log(msg):
    print(time.strftime('%m-%d %H:%M:%S'), msg, flush=True)

# ---------- 系统命令 ----------

# 临时截图按进程隔离：主循环和 `probe`/`once` 调试模式同时跑时，
# 固定路径会互相覆盖，PIL 直接报 truncated。
_TMP = '/tmp/wxa_%d' % os.getpid()

# 判重时间窗（秒）：同样的内容在这么久之内重复出现，才当成「同一条消息被扫了两遍」。
# 超过这个窗口还来同样一句，说明人家是真的又问了一次，必须回。
# 十分钟足够容纳红点没消、重试、轮询抖动这些重复扫描场景。
DUP_WINDOW = 600


# ---------- 聊天归档：上下文落盘（和 QQ 共用一套格式） ----------
# 为什么要有这个：上下文原先是进程内字典，agent 一重启就清零，模型又回到
# 「每次只看到孤零零一句话」——「快点」「发呀」这种两个字的消息没有上文，
# 必然回「没看懂」。文件才是真相来源，重启、换进程都还在。
#
# 存储：{ARCHIVE_DIR}/wx-YYYY-MM-DD.jsonl，按北京时区分天，一行一条，
# 字段压成单字母，和 src/core/qq/archive.js **完全一致**（宿主机
# sync_wx_archive.py 会把它们汇进 /opt/secretary/.data/archive/wechat/，
# 桌面端查归档时两个平台一次看完）：
#
#   t 时间戳(秒)   c private/group   id 会话 ID   n 会话名
#   s 发送者 ID    sn 发送者名       me 是不是我发的
#   x 正文         k text/image
ARCHIVE_DIR = os.environ.get('WX_ARCHIVE') or (
    '/data/archive' if os.path.isdir('/data') else '/tmp/wx_archive')
TZ_OFF = 8 * 3600            # 北京时间：分片按本地日期算，别用 UTC
HIST_MAX = 12                # 塞给模型的最近消息条数（一问一答算两条）

# 监听模式的媒体收件箱：容器 /data/inbox 就是宿主机 /opt/linux-im/inbox。
# 微信拿不到原始媒体文件（纯 C++ 自绘），所以这里存的是**气泡截图**，
# 供用户后续按清单回看；media-index.jsonl 和 QQ 侧字段对齐。
OBS_INBOX = os.environ.get('WX_INBOX') or (
    '/data/inbox' if os.path.isdir('/data') else '/tmp/wx_inbox')
OBS_MAX_BANDS = 12           # 单轮最多处理多少条对方气泡，防历史灌库
OBS_SEEN_WINDOW = 12 * 3600  # 同一条消息在这个秒数内不重复记
# 原来是 1 小时，太短：agent 重启后会把屏幕上还留着的旧消息再归档一遍
# （真实发生过：一次重启让同一条消息在清单里出现两遍）。半天窗口足够覆盖
# 一屏聊天记录的生命周期，代价是同一天里两条一模一样的消息只记一条。

_arc_cache = {}              # path -> ((size, mtime), rows)，按文件状态失效


def _day_of(ts):
    return time.strftime('%Y-%m-%d', time.gmtime(ts + TZ_OFF))


def _arc_path(day):
    return os.path.join(ARCHIVE_DIR, 'wx-%s.jsonl' % day)


def _arc_read(day):
    """读一天的记录。带缓存：文件没变（size+mtime）就不重复解析。"""
    path = _arc_path(day)
    try:
        st = os.stat(path)
    except OSError:
        return []
    key = (st.st_size, st.st_mtime)
    hit = _arc_cache.get(path)
    if hit and hit[0] == key:
        return hit[1]
    rows = []
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except Exception:
                    pass     # 进程被杀时会留半行，跳过，别让整次读失败
    except Exception as e:
        log('archive read fail: %s' % e)
        return []
    _arc_cache[path] = (key, rows)
    return rows


def arc_append(session, text, me=False, kind='text', ts=None, extra=None):
    """记一条。失败一律吞掉——归档绝对不能影响收发主链路。

    extra 供监听模式补 src / m / shot 等字段，普通回复链路不传，
    写出来的行和以前逐字一致（和 QQ archive.js 保持兼容）。
    """
    if not session:
        return False
    ts = int(ts or time.time())
    # c 必须是 group/private，不能写死 private：桌面端「消息数据库」按这个
    # 字段区分群聊和一对一，写死会让所有群消息在库里冒充私聊（QQ 那边是
    # archive.js 按 group_id 判的，这里是同一个语义）。
    chat = 'group' if is_group_chat(session) else 'private'
    rec = {'t': ts, 'c': chat, 'id': session, 'n': session,
           's': 'me' if me else session, 'sn': '', 'me': bool(me),
           'x': (text or '')[:1000], 'k': kind}
    if extra:
        rec.update(extra)
    path = _arc_path(_day_of(ts))
    try:
        os.makedirs(ARCHIVE_DIR, exist_ok=True)
        with open(path, 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
        # 顺手把刚写的这一行接进缓存，省掉下一次整文件重解析
        hit = _arc_cache.get(path)
        if hit:
            hit[1].append(rec)
            st = os.stat(path)
            _arc_cache[path] = ((st.st_size, st.st_mtime), hit[1])
        return True
    except Exception as e:
        log('archive append fail: %s' % e)
        return False


def arc_incoming(session, text):
    """记一条收到的消息。判重窗口内已经记过的同一条，不再记第二遍。

    只看「最后一条」是不够的：只要上一条正好是我的回复，同一条消息被重新
    扫一遍就会被当成新消息，上下文里出现两遍同样的话。这里在时间窗内往回翻，
    命中同会话同文本就直接跳过。文件是按时间顺序写的，遇到超窗口的就可以停。
    """
    if not session or not text:
        return False
    now = time.time()
    for r in reversed(_arc_read(_day_of(now))):
        if now - r.get('t', 0) > DUP_WINDOW:
            break
        if r.get('id') == session and (not r.get('me')) and r.get('x') == text:
            return False
    return arc_append(session, text, me=False)


def hist_text(session, n=HIST_MAX, excl=None):
    """会话最近 n 条 -> 给模型看的纯文本。跨天：先读昨天再读今天。

    excl 是「当前这条」的原文：收到的消息在调模型之前就归档了，不剔掉的话
    模型会看到「对方：快点」出现两遍（一遍在上下文里、一遍是 user message），
    回得更糊涂。QQ 那边是同一个处理。
    """
    if not session:
        return ''
    days = [_day_of(time.time() - 86400), _day_of(time.time())]
    rows = []
    for d in days:
        rows.extend(r for r in _arc_read(d) if r.get('id') == session)
    out = []
    for r in rows:
        body = r.get('x') or ''
        if not body:
            body = '（发了个图片）' if r.get('k') == 'image' else ''
        if not body:
            continue
        out.append(('我：' if r.get('me') else '对方：') + body.replace('\n', '；'))
    if excl:
        cur = '对方：' + excl.replace('\n', '；')
        while out and out[-1] == cur:
            out.pop()
    return '\n'.join(out[-n:])



# ---------- X11 直连：截图与输入 ----------
# 为什么不用 import / xdotool：
#   `import -window root` 一次 90ms（-crop 也一样，它是先抓全屏再裁）；
#   xdotool 每次起进程 5~20ms，发一条消息要按 7 次键、点 1 次鼠标，光进程开销就 100ms+。
# 直连 Xlib：XGetImage 抓窗口 13~36ms（抽样像素与 import 逐点一致），
# XTest 发按键/点击 0.1ms（事件由 X 服务器保序投递，不必再靠 sleep 排队）。
# 初始化失败（没装 libXtst、连不上 DISPLAY）就整体退回旧路径，不影响可用性。
try:
    _x11 = ctypes.CDLL('libX11.so.6')
    _xtst = ctypes.CDLL('libXtst.so.6')
    _x11.XOpenDisplay.restype = ctypes.c_void_p
    _x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    _DPY = _x11.XOpenDisplay(DISPLAY.encode())


    class _XImage(ctypes.Structure):
        _fields_ = [('width', ctypes.c_int), ('height', ctypes.c_int),
                    ('xoffset', ctypes.c_int), ('format', ctypes.c_int),
                    ('data', ctypes.c_void_p), ('byte_order', ctypes.c_int),
                    ('bitmap_unit', ctypes.c_int), ('bitmap_bit_order', ctypes.c_int),
                    ('bitmap_pad', ctypes.c_int), ('depth', ctypes.c_int),
                    ('bytes_per_line', ctypes.c_int), ('bits_per_pixel', ctypes.c_int)]


    _x11.XGetImage.restype = ctypes.POINTER(_XImage)
    _x11.XGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
                               ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int]
    _x11.XDestroyImage.argtypes = [ctypes.POINTER(_XImage)]
    _x11.XDefaultRootWindow.restype = ctypes.c_ulong
    _x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    _x11.XDisplayWidth.argtypes = [ctypes.c_void_p, ctypes.c_int]
    _x11.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]
    _x11.XFlush.argtypes = [ctypes.c_void_p]
    _x11.XStringToKeysym.restype = ctypes.c_ulong
    _x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
    _x11.XKeysymToKeycode.restype = ctypes.c_ubyte
    _x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    _xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    _xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    _xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                           ctypes.c_int, ctypes.c_ulong]
    _ROOT = _x11.XDefaultRootWindow(_DPY)
    _SCREEN = (_x11.XDisplayWidth(_DPY, 0), _x11.XDisplayHeight(_DPY, 0))
    _KC = {}
    if not _DPY:
        raise RuntimeError('XOpenDisplay 返回空')
except Exception as _e:
    _DPY = None
    _KC = {}
    log('X11 直连不可用（%s），退回 import/xdotool' % _e)


def xshot(crop=None):
    """XGetImage 直抓，返回 PIL Image。crop=(x,y,w,h) 屏幕绝对坐标，None=整屏。

    depth 24 / bpp 32 / 小端，字节序是 BGRX，直接交给 PIL 的 raw decoder，
    不用 Plot 逐点拼（那样反而比 import 还慢）。frombuffer 是零拷贝视图，
    必须先 copy 再 XDestroyImage，否则拿到的是已释放的内存。
    """
    from PIL import Image
    if _DPY is None:
        return None
    if crop:
        cx, cy, cw, ch = [int(v) for v in crop]
    else:
        cx = cy = 0
        cw, ch = _SCREEN
    p = _x11.XGetImage(_DPY, _ROOT, cx, cy, cw, ch, 0xFFFFFFFF, 2)   # 2 = ZPixmap
    if not p:
        return None
    xi = p.contents
    buf = ctypes.string_at(xi.data, xi.bytes_per_line * xi.height)
    im = Image.frombuffer('RGB', (xi.width, xi.height), buf, 'raw', 'BGRX', xi.bytes_per_line, 1)
    im = im.copy()
    _x11.XDestroyImage(p)
    return im


def snap(crop=None):
    """截一块并返回 PIL Image（不再落盘）。"""
    from PIL import Image
    im = xshot(crop)
    if im is not None:
        return im
    p = grab(crop) if crop else screenshot()
    return Image.open(p).convert('RGB')


def _im(x):
    """统一入口：已经是 Image 就直接用，是路径就打开。
    原来这些函数都只吃路径（内部 Image.open），改成两边都收，
    主循环就能全程拿内存图，省掉「写 PPM + 再读回来」那一趟。"""
    from PIL import Image
    return x if isinstance(x, Image.Image) else Image.open(x).convert('RGB')


def _keycode(name):
    kc = _KC.get(name)
    if kc is None:
        ks = _x11.XStringToKeysym(name.encode())
        kc = _x11.XKeysymToKeycode(_DPY, ks)
        _KC[name] = kc
    return kc


def key(name, ctrl=False):
    """按一个键。XTest 直连，0.1ms；xdotool 每次要起进程。"""
    if _DPY is None:
        sh('xdotool key --clearmodifiers %s' % (('ctrl+' + name) if ctrl else name))
        return
    k = _keycode(name)
    c = _keycode('Control_L') if ctrl else 0
    if ctrl:
        _xtst.XTestFakeKeyEvent(_DPY, c, True, 0)
    _xtst.XTestFakeKeyEvent(_DPY, k, True, 0)
    _xtst.XTestFakeKeyEvent(_DPY, k, False, 0)
    if ctrl:
        _xtst.XTestFakeKeyEvent(_DPY, c, False, 0)
    _x11.XFlush(_DPY)


def mouse_click(x, y):
    """移动 + 按下 + 抬起。X 服务器按序投递，不需要旧的 0.06/0.03 两段 sleep；
    只留 20ms 让指针位置先落地（CEF 处理点击时会读当前指针）。"""
    if _DPY is None:
        sh('xdotool mousemove %d %d' % (x, y))
        time.sleep(0.06)
        sh('xdotool mousedown 1')
        time.sleep(0.03)
        sh('xdotool mouseup 1')
        return
    _xtst.XTestFakeMotionEvent(_DPY, -1, int(x), int(y), 0)
    _x11.XFlush(_DPY)
    time.sleep(0.02)
    _xtst.XTestFakeButtonEvent(_DPY, 1, True, 0)
    _xtst.XTestFakeButtonEvent(_DPY, 1, False, 0)
    _x11.XFlush(_DPY)




def sh(cmd, timeout=20):
    return subprocess.run(cmd, shell=True, capture_output=True, timeout=timeout, env=ENV,
                          stdin=subprocess.DEVNULL)

def _shot_cmd(path, crop=None):
    """截图命令。统一输出 8 位 PPM：
    实测 PNG 170ms / PPM 101ms，PIL 打开 25ms / 11ms —— 每轮省近 100ms。
    PPM 必须显式 -depth 8，否则 ImageMagick 出 16 位，PIL 读会报 Too many colors。
    调用方没给路径时走 _TMP（带 pid），否则 `probe`/`once` 调试模式和主循环
    会写同一个 /tmp/_list.ppm，互相把对方的图截断，PIL 报
    `image file is truncated`——踩过。"""
    if crop:
        x, y, w, h = crop
        return 'import -window root -crop %dx%d+%d+%d +repage -depth 8 %s' % (w, h, x, y, path)
    return 'import -window root -depth 8 %s' % path


def screenshot(path=None):
    """整屏截图，返回文件路径（调试脚本在用）。
    主循环走 shot()，不再落盘——写 2.4MB PPM 再读回来纯属多余。"""
    p = path or _TMP + '_s.ppm'
    im = xshot()
    if im is None:
        sh(_shot_cmd(p), timeout=15)
    else:
        im.save(p)
    return p


def grab(crop, path=None):
    """只抓一小块（屏幕绝对坐标 x,y,w,h），返回文件路径。"""
    p = path or _TMP + '_g.ppm'
    im = xshot(crop)
    if im is None:
        sh(_shot_cmd(p, crop), timeout=15)
    else:
        im.save(p)
    return p

def win_geometry():
    """微信主窗口 x,y,w,h（屏幕绝对坐标）。可能有多个同名窗口，取面积最大的。"""
    r = sh('xdotool search --onlyvisible --name "^Weixin$"')
    wids = r.stdout.decode().split()
    best = None
    for wid in wids:
        g = sh('xdotool getwindowgeometry --shell %s' % wid)
        d = dict(l.split('=', 1) for l in g.stdout.decode().splitlines() if '=' in l)
        try:
            x, y, w, h = int(d['X']), int(d['Y']), int(d['WIDTH']), int(d['HEIGHT'])
        except (KeyError, ValueError):
            continue
        if best is None or w * h > best[2] * best[3]:
            best = (x, y, w, h)
    return best

_WID = [None]


def activate_win():
    """激活微信窗口。注意：已经激活时**不要再调 windowactivate**，
    否则会把 CEF 输入框的内部焦点冲掉，后面所有按键都进不去。

    windowactivate --sync 只保证窗口被 map，openbox 把焦点交过去还要一点时间；
    这期间发出去的点击会被 WM 吃掉（表现为「点了没反应，聊天区还是上一个会话」）。
    所以激活后要确认 activewindow 真的是它，宁可多花 100ms 也别点空。
    """
    wid = _WID[0]
    if not wid:
        wid = sh('xdotool search --onlyvisible --name "^Weixin$" | head -1').stdout.decode().strip()
        if not wid:
            return wid
        _WID[0] = wid          # 窗口 id 不会变，缓存掉这次 xdotool 查询
    cur = sh('xdotool getactivewindow').stdout.decode().strip()
    if cur != wid:
        sh('xdotool windowactivate --sync %s' % wid)
        for _ in range(8):
            if sh('xdotool getactivewindow').stdout.decode().strip() == wid:
                break
            time.sleep(0.03)
        time.sleep(0.08)
    return wid

def click(x, y, settle=0.10):
    """点击。必须把「移动」和「按下」分成两条命令——
    CEF 收到同一条命令里的 move+click 时，可能还在用旧指针位置处理这次点击，
    表现为“有时候点得中、有时候点不中”。

    实测：move→down 间隔 0.06s 仍 3/3 命中（原来 0.28s 是白等），
    点击后到会话切换完成只要 250~264ms，所以 settle 给 0.10 就够，
    真正需要等的地方由 open_session 轮询确认，不再死等。
    """
    mouse_click(x, y)
    if settle:
        time.sleep(settle)

def paste_text(text):
    """把文本放进剪贴板并 Ctrl+V（走文件，避免 shell 转义；xclip 会 fork 常驻，必须断开管道）"""
    with open(_TMP + '_paste.txt', 'w', encoding='utf-8') as f:
        f.write(text)
    sh('xclip -selection clipboard -i %s_paste.txt </dev/null >/dev/null 2>&1' % _TMP, timeout=10)
    time.sleep(0.04)
    key('v', ctrl=True)

def press_enter():
    key('Return')

# ---------- 图像处理 ----------

def find_unread_rows(img_path, win, origin=None):
    """在会话列表区域找未读红点所在行。返回屏幕 y 坐标列表。
    实测布局：窗口内列表区 x 63..315（约 7%~34%）

    origin=(ox,oy) 表示传进来的图**已经是**那条列表条带、左上角在屏幕 (ox,oy)。
    轮询时只抓 246x680 的条带（X 直连 ~3ms），不再抓整屏再裁。
    origin=None 时按老用法处理：图是整屏，内部自己裁条带。

    性能：原实现逐像素扫 94x680=6.4 万点要 54ms。红点是 8~10px 的实心圆，
    先按 NEAREST 缩小 3 倍再扫（逐像素少了 9 倍），约 8ms，返回坐标乘回 3。
    行高 70px，3px 的精度对点击毫无影响。另外扫描宽度从 0.34 收到 0.31：
    红点贴在行右边缘（约 0.30~0.33），左边 0.07~0.30 全是不可能出现红点的空白，
    白扫一遍纯属浪费。"""
    im = _im(img_path)
    if origin is None:
        x, y, w, h = win
        ox = x + int(w * 0.07)
        oy = y
        box = im.crop((ox, oy, x + int(w * 0.31), y + h))
    else:
        ox, oy = origin
        box = im
    S = 3
    small = box.resize((max(1, box.width // S), max(1, box.height // S)), Image.NEAREST)
    px = small.load()
    W, H = small.size
    rows = []
    for yy in range(H):
        cnt = 0
        for xx in range(W):
            r, g, b = px[xx, yy]
            if r > 195 and g < 95 and b < 95:   # 微信红 #fa5151 附近
                cnt += 1
        if cnt >= 2:
            rows.append(yy)
    # 聚类相邻行
    out, last = [], -10
    for yy in rows:
        if yy - last > 2:
            out.append(oy + yy * S)
        last = yy
    return out

def ocr(path, psm=6, lang='chi_sim'):
    """tesseract 识别（CLI 版，只在常驻实例初始化失败时兜底）。

    语言包实测：chi_sim 单独跑的消息正文与 chi_sim+eng 结果一字不差，
    耗时却少 35~40%（452ms vs 740ms）。英文只在联系人名上才有意义，
    所以正文默认只用 chi_sim；需要认英文时显式传 lang='chi_sim+eng'。
    """
    r = subprocess.run(['tesseract', path, 'stdout', '-l', lang, '--psm', str(psm)],
                       capture_output=True, timeout=30, env=ENV)
    return r.stdout.decode('utf-8', 'replace')


# ---------- 常驻 OCR：ctypes 直连 libtesseract ----------
# 每跑一次 tesseract CLI 都要付 ~320ms 的进程启动 + 模型加载，真正的识别只占
# 100~260ms。实测同一张气泡图：CLI 528~680ms，常驻 API 111~270ms，**输出逐字一致**。
# 主循环一次要 OCR 两处（标题 + 正文），光这一项就能省 800ms 上下。
# CLI 只在 libtesseract 缺失或初始化失败时兜底，保证不至于整条链路不能用。
_TESS_LIB = None            # None=未初始化 / False=不可用 / 其他=已加载的 CDLL
_TESS_APIS = {}             # lang -> api 指针（False 表示该语言初始化失败）
_TESS_DATA = None


def _tess_lib():
    global _TESS_LIB, _TESS_DATA
    if _TESS_LIB is None:
        try:
            import ctypes
            import glob
            lib = ctypes.CDLL('libtesseract.so.4')
            lib.TessVersion.restype = ctypes.c_char_p
            lib.TessBaseAPICreate.restype = ctypes.c_void_p
            lib.TessBaseAPIInit3.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
            lib.TessBaseAPIInit3.restype = ctypes.c_int
            lib.TessBaseAPISetPageSegMode.argtypes = [ctypes.c_void_p, ctypes.c_int]
            lib.TessBaseAPISetImage.argtypes = [ctypes.c_void_p, ctypes.c_char_p,
                                                ctypes.c_int, ctypes.c_int,
                                                ctypes.c_int, ctypes.c_int]
            lib.TessBaseAPIGetUTF8Text.argtypes = [ctypes.c_void_p]
            lib.TessBaseAPIGetUTF8Text.restype = ctypes.c_void_p
            lib.TessDeleteText.argtypes = [ctypes.c_void_p]
            _TESS_LIB = lib
            for cand in glob.glob('/usr/share/tesseract-ocr/*/tessdata'):
                _TESS_DATA = cand
                break
        except Exception as e:
            log('常驻 OCR 不可用，退回 CLI：%s' % e)
            _TESS_LIB = False
    return _TESS_LIB or None


def _tess_api(lang):
    lib = _tess_lib()
    if not lib:
        return None
    api = _TESS_APIS.get(lang)
    if api is None:
        api = lib.TessBaseAPICreate()
        rc = lib.TessBaseAPIInit3(api, _TESS_DATA.encode() if _TESS_DATA else None,
                                  lang.encode())
        if rc != 0:
            log('OCR 初始化失败 rc=%d lang=%s' % (rc, lang))
            _TESS_APIS[lang] = False
            return None
        lib.TessBaseAPISetPageSegMode(api, 6)
        _TESS_APIS[lang] = api
    return api or None


def ocr_img(im, psm=6, lang='chi_sim'):
    """对 PIL 图直接识别（常驻，不起进程）。失败自动退回 CLI。"""
    lib = _tess_lib()
    api = _tess_api(lang) if lib else None
    if not api:
        p = _TMP + '_ocr.png'
        im.save(p)
        return ocr(p, psm, lang)
    import ctypes
    if im.mode != 'RGB':
        im = im.convert('RGB')
    w, h = im.size
    lib.TessBaseAPISetPageSegMode(api, psm)
    lib.TessBaseAPISetImage(api, im.tobytes(), w, h, 3, w * 3)
    ptr = lib.TessBaseAPIGetUTF8Text(api)
    try:
        return ctypes.string_at(ptr).decode('utf-8', 'replace')
    finally:
        lib.TessDeleteText(ptr)


def ocr_region(img_path, box, psm=6, lang='chi_sim'):
    """裁一块区域识别。走常驻实例，省掉存盘和进程启动。"""
    return ocr_img(_im(img_path).crop(box), psm, lang)

# ---------- 业务逻辑 ----------

def norm(s):
    """去掉所有空白，OCR 出来的名字常带空格（File Transfer / FileTransfer）"""
    return re.sub(r'\s+', '', s or '').lower()


def in_whitelist(title, wl):
    """白名单匹配。wl 里写 '*' 表示放行所有会话（用户要求"回复所有人"时用）。"""
    if not wl:
        return False
    if '*' in wl:
        return True
    t = norm(title)
    return any(norm(k) and norm(k) in t for k in wl)


# 群聊标题形如「摸鱼群 (8)」「家人群（12）」。顺带把公众号/服务通知的
# 特殊会话也排除掉——它们不会看回复，回了纯属浪费配额还可能踩风控。
_GROUP_RE = re.compile(r'[(（]\s*\d{1,4}\s*[)）]')
_GROUP_NAME_RE = re.compile(r'(群|群聊|团队)$')
_SKIP_TITLES = ('微信团队', '微信支付', '服务通知', '订阅号消息', '文件传输助手', '腾讯新闻')


def is_group_chat(title):
    """群聊判定：优先看标题里的 `(237)` 人数后缀，其次看名字本身。

    很多群的名字里根本不带人数（「乌鲁木齐昌吉家教兼职群」），只靠 `(N)`
    会把群消息全记成私聊，消息库里就分不清「谁在群里说」和「谁单独找我」。
    """
    t = title or ''
    if _GROUP_RE.search(t):
        return True
    return bool(_GROUP_NAME_RE.search(t))


def should_skip_session(title, cfg):
    """返回跳过原因，None 表示可以处理"""
    if not title:
        return 'no-title'
    if cfg.get('skipGroup', True) and is_group_chat(title):
        return 'group'
    t = norm(title)
    for s in _SKIP_TITLES:
        if norm(s) and norm(s) in t:
            return 'system:' + s
    return None


def check_guard(cfg, st, session):
    now = time.time()
    if now - st.get('hourStart', 0) > 3600:
        st['hourStart'], st['hourCount'] = now, 0
    if st['hourCount'] >= cfg['maxPerHour']:
        return 'hourly-limit'
    last = st.get('lastReply', {}).get(session, 0)
    if now - last < cfg['sessionCooldown']:
        return 'cooldown'
    return None

# LLM 客户端总时限（秒）。服务端排队时可能到 5s，不设这个上限就只能等
# requests 的 read timeout（20s），对话会长时间僵在那里。
LLM_DEADLINE = 3.5

# 单独一个线程用来「等 LLM」。这里能并行，是因为一个是网络等待、一个是
# tesseract 计算，**不是两个 tesseract 并行**——后者会互相踩（见 open_chat 注释）。
_LLM_EXEC = ThreadPoolExecutor(max_workers=1, thread_name_prefix='wxllm')

# 复用连接：每次新建 requests.post 都要重做 TCP+TLS 握手（约 100~200ms）
_SESS = None


def _session():
    global _SESS
    if _SESS is None:
        import requests
        _SESS = requests.Session()
    return _SESS


# 模型崩坏的典型长相：中文回复里突然冒出成串大写字母（ENERGY / MAR BCS S）。
# 用 3 个以上连续大写判定，避免误伤 "OK"、"PDF" 这类正常缩写。
_BAD_EN_RE = re.compile(r'[A-Z]{3,}')


def _quality_ok(txt):
    if not txt or len(txt) > 60:
        return False
    cn = sum(1 for ch in txt if '\u4e00' <= ch <= '\u9fa5')
    if cn == 0:
        return len(txt.strip()) >= 1        # 纯英文回复也合理，放行
    if cn < 6 and _BAD_EN_RE.search(txt):
        return False
    return True


def _shorten(t, limit=15):
    """把回复压到「一眼看完」的长度，作为提示词失效时的兜底。

    提示词能管住绝大多数情况，但模型偶尔仍会一次给两句。这里只做两件
    保守的事，不猜语义：
      1. 去掉句末句号——真人发微信基本不打句号，打了就显书面。
      2. 超长时在**最后一个标点处**截断，保住语义完整；实在没标点才硬切。
    """
    t = (t or '').strip().strip('“”"\'「」')
    t = re.sub(r'[。．.]+$', '', t).strip()
    if len(t) <= limit:
        return t
    cut = None
    for i, ch in enumerate(t[:limit + 3]):
        if ch in '，,、；;！!？?':
            cut = i
    if cut is not None and cut >= 3:
        t = t[:cut]
    if len(t) > limit:
        t = t[:limit]
    return t.rstrip('，,、；;。．.！!？? ')


def _split_msg(t, max_parts=2):
    """按句末标点把回复切成多条（最多 max_parts 条）。

    真人发微信是一句一条，不是一次甩一整段——`wechat-simulate-human` 就是
    靠这个 + 「按字数算停顿」做出拟人感的。切分规则照抄它：
    在句末标点**之后**切，但「？」「！」后面还跟着另一个问叹号时不切，
    免得把「？！？」切碎。最后一条把剩余内容合并，避免切得太碎。
    """
    parts = [p.strip() for p in re.split(r'(?<=[。！？!?])(?![？！！?])', t) if p.strip()]
    # 每条都要像真人：句末不带句号（_shorten 只清了整句的尾巴，切完得逐条清）
    parts = [re.sub(r'[。．.]+$', '', p).strip() for p in parts]
    parts = [p for p in parts if p]
    if len(parts) <= 1:
        return parts or [t]
    if len(parts) > max_parts:
        parts = parts[:max_parts - 1] + [''.join(parts[max_parts - 1:])]
    return parts


def _stream_chat(llm, body):
    """流式取回整段回复。

    为什么要流式（实测同一批输入各跑 4 条）：
      非流式 625~805ms（生产上还出现过 964 / 1215ms 的毛刺）
      流式   463~762ms，TTFT 只有 348~458ms
    服务端不用把整包攒齐才发，尾延迟和毛刺都小。回复本来就短（几 token），
    所以这里不做「攒到第一个句号就先发出」那种提前收工——同一句话被截一半
    发出去，比慢 100ms 更难接受。

    另：**提示词长度在这台服务上不是瓶颈**。把 297 字人设换成 24 token 的
    短提示词反而更慢（852~1155ms），说明耗时在排队和首 token，不在 prefill。
    所以别为了省时间动人设。
    """
    import json as _json
    url = llm['baseUrl'].rstrip('/') + '/chat/completions'
    parts = []
    t0 = time.monotonic()
    timed_out = False
    with _session().post(url, headers={'Authorization': 'Bearer ' + llm['apiKey']},
                         json=body, timeout=(5, 20), stream=True) as r:
        r.raise_for_status()
        for line in r.iter_lines(decode_unicode=False):
            # 客户端总时限。不设的话，服务端排队时 requests 的 read timeout（20s）
            # 才是唯一止损点——实测真出现过一次 5.2s 才回来，把人卡在"没反应"。
            if time.monotonic() - t0 > LLM_DEADLINE:
                timed_out = True
                break
            if not line or not line.startswith(b'data: '):
                continue
            payload = line[6:]
            if payload == b'[DONE]':
                break
            try:
                j = _json.loads(payload)
                delta = (j['choices'][0].get('delta') or {}).get('content')
            except Exception:
                continue
            if delta:
                parts.append(delta)
                if sum(len(p) for p in parts) > 40:    # 兜底，别让模型啰嗦下去
                    break
    txt = ''.join(parts).strip()
    if timed_out:
        # 有字就用（回复本来就一两句，超时那一刻多半已经生成完），没字才放弃。
        # 宁可这一条晚一点/不回，也不要把半句话发出去，或者卡住二十秒。
        log('LLM 超过 %.1fs 未结束，用已有内容 %r' % (LLM_DEADLINE, txt[:30]))
    return txt


# ---------- 表情包挑选（和 QQ 共用 /data/media 素材池） ----------
# 素材是 QQ 那边攒的 387 张梗图，索引 library.json 里带一句"什么场合用"的描述。
# 提示词只给「序号. 用途」，模型不会有耐心复述中文文件名，实测它只肯写 [图:11]。
MEDIA_LIB = os.path.join(MEDIA, 'library.json')
# 只有这些话题才把清单塞进去：清单本身 ~200 token，每轮都带会拖首 token 时间。
PIC_TRIGGER_RE = re.compile(r'图|表情|斗图|梗|贴纸|发张|来张|看看|照片|自拍|拍一|拍个')

# 对方**明确伸手要**图（不是随口提「图」字）。这类消息模型的默认反应是反问
# 「什么照片啊」「你要哪种的」——线上真实发生：对方连说「发个照片」「快点」，
# 它一个字没发。所以这类要额外强指令，再加一层代码兜底。
PIC_ASK_RE = re.compile(
    r'(发|来|整|给|晒|甩)[^。！？\n]{0,4}(照片|图片|图|表情|自拍)'
    r'|(照片|图片|表情|自拍)[^。！？\n]{0,3}(发|来|整|看)'
    r'|(有|有没有)[^。！？\n]{0,3}(照片|图片|表情|自拍)')


def load_pic_list(n=24):
    """随机抽一批带描述的表情。固定取最新会让老图永远发不出去。"""
    try:
        with open(MEDIA_LIB, encoding='utf-8') as f:
            idx = json.load(f)
    except Exception:
        return []
    pool = [x for x in idx.get('pics', []) if x.get('desc') and x.get('id')]
    random.shuffle(pool)
    return pool[:n]


def pic_prompt(items):
    return '\n'.join('%d. %s' % (i + 1, str(x['desc'])[:24]) for i, x in enumerate(items))


def resolve_pic(items, token):
    """[图:3] → 文件路径。序号、文件名、描述前缀都认，序号越界就放弃。"""
    t = str(token or '').strip().lstrip('#＃')
    if not t:
        return None
    if t.isdigit() and items:
        n = int(t)
        if 1 <= n <= len(items):
            p = os.path.join(MEDIA, 'pics', items[n - 1]['id'])
            if os.path.exists(p):
                return p
    for x in items or []:
        if t and (x['id'] == t or str(x['id']).startswith(t)):
            p = os.path.join(MEDIA, 'pics', x['id'])
            if os.path.exists(p):
                return p
    return None


def llm_reply(cfg, session, incoming, hist=''):
    """调模型生成回复。

    模型固定 deepseek-ai/DeepSeek-V4.1-Flash（用户指定，不换模型）。

    **必须显式关掉思考（enable_thinking=False）**，这是全链路最大的一笔提速：
    Flash 默认带思维链，会先吐 60~70 个推理 token 再给正文，实测
    completion 73~83 tokens、耗时 2.0~3.6s；关掉后 completion 只剩 7~9 tokens，
    耗时稳定在 0.74~0.76s，且回复更贴「15 字以内」——思考反而让答案变长变啰嗦。

    注意 SiliconFlow 上 `chat_template_kwargs={'thinking': False}` 无效（仍带思维链），
    只有顶层 `enable_thinking=False` 生效。
    """
    import requests
    llm = cfg['llm']
    # hist 由主循环按会话名从进程内滚动窗口传进来；兼容老调用方（空串时退回 cfg）
    if not hist:
        hist = cfg.get('history', {}).get(session, '')
    hist = hist[-600:]
    # 原来这句写的是「含糊带过或**反问**」——等于亲手教它反问，和「别每句都反问」
    # 直接打架。改成含糊带过就好。
    # session 传空表示「还没读标题就先发请求了」，这时不要拼出「和「」聊天」
    name_line = ('\n你在微信上和「%s」聊天。' % session) if session else ''
    # 只在对方提到图/表情这类话题时才塞清单：清单本身约 200 token，
    # 每轮都带会把首 token 时间拉长，而八成对话根本用不上图。
    ask_pic = bool(PIC_ASK_RE.search(incoming or ''))
    pics = load_pic_list() if (ask_pic or PIC_TRIGGER_RE.search(incoming or '')) else []
    pic_hint = ''
    if pics:
        if ask_pic:
            # 对方在要图，这时候反问「什么照片」等于没理人。给强指令。
            pic_hint = ('\n\n对方在跟你要图。手头这些图，清单是「序号. 什么场合用」：\n'
                        + pic_prompt(pics) +
                        '\n**必须挑一张发出去**：在回复末尾写 [图:序号]，只写序号。'
                        '不要反问「什么照片」「要哪种」，也不要道歉说没有、不方便。')
        else:
            pic_hint = ('\n\n手头有些表情包，清单是「序号. 什么场合用」：\n' + pic_prompt(pics) +
                        '\n想配图就在回复末尾加 [图:序号]，只写序号。'
                        '不想发就别写，也不要解释这件事。')
    sys_p = (llm['persona']
             + '\n\n如果记不清对方提过的事，就含糊带过，不要编造具体片名、人名、时间和数字。'
             # 这句是刚需，不是客套。微信这边只能截图 OCR，字形相近的字会认错
             # （实测「发」→「必」、「照」→「昭」、「喜」→「坦」），字面能对上
             # 七八成就是原话。不交代这条，模型遇到一个怪字就整句说「没看懂」，
             # 对方得到的是「我不理你」，比答错还伤人。
             + '\n\n对方的消息是截图识别出来的，可能有个别错字或漏字。'
               '按上下文和读音去理解，能猜出大意就正常接话，'
               '**不要因为有一两个字看不懂就说「没看懂/没听懂」**。'
             + name_line
             + pic_hint
             + (('最近聊天记录（最后一条是对方最新消息）：\n' + hist) if hist else ''))
    body = {'model': llm['model'],
            'messages': [{'role': 'system', 'content': sys_p},
                         {'role': 'user', 'content': incoming}],
            # 15 个字 ≈ 15~20 token，24 留一点余量；
            # 给 60 是给「话痨」开门，模型会顺手多写
            'max_tokens': 34 if pics else 24, 'temperature': 0.75,
            'enable_thinking': False,
            'stream': True}
    try:
        txt = _stream_chat(llm, body)
    except Exception as e:
        log('LLM fail: %s' % e)
        return None
    if not txt:
        return None
    # 先把 [图:3] 摘出来，剩下的才是要发的话。
    # 模型偶尔写成 [图: 3] / ［图3］ / [图:文件名字]，正则都吃下来，解析交给 resolve_pic。
    pic = None
    m = re.search(r'[\[［]图[:：\s]*([^\]］]{1,30})[\]］]', txt)
    if m:
        pic = resolve_pic(pics, m.group(1))
        txt = (txt[:m.start()] + txt[m.end():]).strip()
        txt = re.sub(r'[，,、。\s]+$', '', txt)
        if not pic:
            log('[图] 解析不到：%r' % m.group(1))
    txt = re.sub(r'[\*#`>]', '', txt).strip()
    txt = _shorten(txt)
    # 兜底：对方明确要图，模型还是没给（反问 / 装没看见 / 说「不方便」）。
    # 随机补一张——对方要的是「有反应」，不是「精确命中」这张图。
    # 只在明确索要时兜底，随口提到「图」字不乱发，否则就成了无脑刷图机器人。
    if ask_pic and not pic and pics:
        cand = [x for x in pics if os.path.exists(os.path.join(MEDIA, 'pics', x['id']))]
        if cand:
            pick = random.choice(cand)
            pic = os.path.join(MEDIA, 'pics', pick['id'])
            # 模型这时候多半在反问「你要哪张图啊」——提示词写了不让问，它还是问。
            # 反问和图片一起发出去会很分裂（一边问一边给），干脆换成一句配图的话。
            if not txt or re.search(r'哪|什么图|哪种|要哪', txt):
                txt = random.choice(['喏', '给你', '看这个', '拿去'])
            log('[图] 对方明确要图但模型没给，兜底发 %s（%s）'
                % (pick['id'], str(pick.get('desc'))[:16]))
    if not txt and not pic:
        return None
    if txt and not _quality_ok(txt):
        log('LLM 输出不合格 %r，放弃本次回复' % (txt[:40],))
        return None
    return txt, pic

# 纵向实测边界（窗口高度比例，1280x800 / 窗口 917x667 下量的）：
#   标题栏分隔线 0.124 | 消息区 0.126~0.778 | 输入框 0.780~0.984 | Send 按钮 0.930~0.970
SEND_BOX = (0.900, 0.925, 0.978, 0.975)   # 实测绿色按钮 x 0.903~0.975 / y 0.928~0.972
INPUT_Y = 0.85      # 输入框文本区中部（实测输入框 0.787~0.984，文本区约 0.79~0.93）


def send_enabled(win):
    """检测 Send 按钮是否为可用态（绿色）。空输入时是灰的。

    只抓按钮那一小块（约 71x34），不再整屏截图再裁：
    全屏截图 101ms + PIL 解码 11ms + 裁切，现在约 95ms，且省掉一次全图解码。
    """
    from PIL import Image
    x, y, w, h = win
    bx = x + int(w * SEND_BOX[0])
    by = y + int(h * SEND_BOX[1])
    bw = int(w * (SEND_BOX[2] - SEND_BOX[0]))
    bh = int(h * (SEND_BOX[3] - SEND_BOX[1]))
    im = snap((bx, by, bw, bh))
    px = im.load()
    cnt = 0
    for yy in range(im.size[1]):
        for xx in range(im.size[0]):
            r, g, b = px[xx, yy]
            if g - r > 40 and g - b > 40 and g > 150:
                cnt += 1
    return cnt > 60


def wait_send_enabled(win, timeout=0.20, step=0.02):
    """等 Send 按钮变绿。

    原来这里固定 sleep 0.08s 赌「粘贴已经落进输入框」。改成轮询：
    大多数时候 20~40ms 就绿了，比死等快；万一界面慢，还会等满 200ms
    再交给后面的兜底分支，比固定 sleep 更稳，不是拿可靠性换速度。
    """
    deadline = time.time() + timeout
    while True:
        if send_enabled(win):
            return True
        if time.time() >= deadline:
            return False
        time.sleep(step)


def _send_gate(what):
    """只收不发模式的**硬闸**：任何发送函数入口都要先过这一关。

    主循环里已经有 observeOnly 分支直接 continue，但那属于业务逻辑，
    将来改代码可能漏；这里兜底，保证「账号绝不发出任何消息」不依赖上层写法。
    手动联调需要真的发一条时，用 WX_ALLOW_SEND=1 显式开口子。
    """
    if os.environ.get('WX_ALLOW_SEND') == '1':
        return False
    try:
        if load_cfg().get('observeOnly'):
            log('[observeOnly] 已拦截发送 %s：本账号只收不发' % what)
            return True
    except Exception:
        pass
    return False


def send_reply(text, win):
    """发送消息。

    要点（踩过的坑）：
      1. 打开会话后输入框本就有焦点，先直接键盘操作；失败再点输入框兜底。
      2. 点击必须分「move / down / up」三步留间隔，否则 CEF 会按旧指针位置处理。
      3. 用 Send 按钮是否变绿确认文字真的进了输入框，而不是盲按回车。
    """
    if _send_gate('文字'):
        return False
    x, y, w, h = win
    activate_win()

    def try_fill():
        # XTest 直发，两个键合起来 0.2ms（旧版一条 xdotool 命令也要 20ms）
        key('a', ctrl=True)
        key('Delete')
        time.sleep(0.03)
        paste_text(text)
        return wait_send_enabled(win)

    if not try_fill():
        click(x + int(w * 0.60), y + int(h * INPUT_Y))
        time.sleep(0.12)
        if not try_fill():
            log('WARN 输入框没拿到焦点，放弃本次发送')
            return False

    press_enter()
    # 回车按下后消息就已经进聊天区了，原来等 0.45s 是纯空转。
    # 留 0.05s 给界面刷新，够后面「最后一条是不是我方消息」的判断用。
    time.sleep(0.05)
    return True

# ---------- 发图片 / 表情包 / 语音 ----------
# 微信这个窗口是纯 C++ 自绘（无 DOM、无插件、无 IPC），"发图"只有一条稳的路：
# 把图片放进 X 剪贴板，再在输入框 Ctrl+V —— 微信会把它当**图片消息**发出去，
# 不是文件消息。GIF 粘过去会保留动画，看起来就是个表情包。


def clip_image(path):
    """把图片塞进 X 剪贴板。

    xclip 会 fork 一个常驻进程持有 selection（剪贴板内容由该进程提供，不是系统
    存下来的），所以必须断开 stdio，否则 sh() 会一直等它退出。
    gif 按 image/gif 传（微信能保住动画），其余统一 image/png（webp 微信不认）。
    """
    ext = os.path.splitext(path)[1].lower()
    mime = 'image/gif' if ext == '.gif' else 'image/png'
    sh('xclip -selection clipboard -t %s -i %s </dev/null >/dev/null 2>&1' % (mime, path), timeout=10)
    time.sleep(0.05)


def send_image(path, win):
    """发一张图片/表情。成功返回 True。

    和发文字的区别：图片没有"文字进了输入框"这种可观测中间态，Send 按钮变绿
    是唯一可靠信号。粘贴大图要先编码，比文字慢，所以 timeout 给到 1.2s。
    """
    if _send_gate('图片'):
        return False
    x, y, w, h = win
    activate_win()
    click(x + int(w * 0.60), y + int(h * INPUT_Y))
    time.sleep(0.10)
    clip_image(path)
    key('v', ctrl=True)
    if not wait_send_enabled(win, timeout=1.2, step=0.03):
        log('发图失败：粘贴后 Send 没变绿（%s）' % os.path.basename(path))
        # 别把图留在输入框里挡住下一条文字
        key('a', ctrl=True)
        key('Delete')
        return False
    press_enter()
    time.sleep(0.05)
    return True


def key_down(name):
    """按下不松（发语音要"按住 Alt 说话"，普通 key() 是 down+up 连发）。"""
    _xtst.XTestFakeKeyEvent(_DPY, _keycode(name), 1, 0)
    _x11.XFlush(_DPY)


def key_up(name):
    _xtst.XTestFakeKeyEvent(_DPY, _keycode(name), 0, 0)
    _x11.XFlush(_DPY)


def _wav_seconds(path):
    """算 wav 时长。

    **不能信头里的 nframes**：SiliconFlow 返回的 wav 是流式写的，RIFF 和 data
    两个长度字段都是 0xFFFFFFFF，wave 模块会读出 21 亿帧（2147483520），
    于是「按住 Alt 的时长」直接算成 8 万秒——实测就是这么卡住的。
    按文件大小 + 头里的采样率估，误差不到 1ms，对按住多久完全没影响。
    """
    size = os.path.getsize(path)
    with open(path, 'rb') as f:
        head = f.read(64)
    rate = 0
    if len(head) >= 28 and head[:4] == b'RIFF':
        rate = int.from_bytes(head[24:28], 'little')
    if not rate or rate > 192000:
        rate = 24000
    return max(0.4, (size - 80) / float(rate * 2))


def send_voice(wav, win):
    """把 wav 喂进虚拟麦克风，同时让微信按住 Alt 录下来发出去。

    微信 4.1.9+ 桌面版支持发语音（按住 Alt 说话、松手即发）。容器没有声卡，
    start-wx2.sh 起了一个 PulseAudio null sink（vsink），它的 monitor 被设成
    默认录音源：TTS 播进 vsink，微信录到的就是这句话——相当于一根虚拟音频线。

    时长的唯一决定因素是"按住多久"，所以先量音频长度，再按长度按住。
    """
    if _send_gate('语音'):
        return False
    secs = _wav_seconds(wav)
    x, y, w, h = win
    activate_win()
    click(x + int(w * 0.60), y + int(h * INPUT_Y))
    time.sleep(0.12)
    key_down('Alt_L')
    time.sleep(0.35)                       # 等微信把录音器拉起来
    t = time.time()
    sh('paplay -d vsink %s </dev/null >/dev/null 2>&1' % wav, timeout=secs + 5)
    time.sleep(0.25)                       # 尾巴别切得太急
    key_up('Alt_L')
    time.sleep(0.20)
    log('语音录完 %.2fs（音频 %.2fs）' % (time.time() - t, secs))
    return True


def tts_wav(text, cfg):
    """文字转语音，返回本地 wav 路径。

    缓存和 QQ 共用同一份思路：同一句同一音色只合成一次（落 /data/media/voice）。
    格式要 wav 而不是 mp3 —— 容器里没有 ffmpeg，paplay 播不了 mp3。
    """
    import requests
    llm = cfg['llm']
    name = hashlib.md5(('wx|%s|%s' % (llm.get('ttsVoice', ''), text)).encode()).hexdigest()[:16]
    d = os.path.join(MEDIA, 'voice')
    os.makedirs(d, exist_ok=True)
    out = os.path.join(d, 'tts-%s.wav' % name)
    if os.path.exists(out) and os.path.getsize(out) > 2000:
        return out
    body = {'model': llm.get('ttsModel', 'FunAudioLLM/CosyVoice2-0.5B'),
            'input': text,
            'voice': llm.get('ttsVoice', 'FunAudioLLM/CosyVoice2-0.5B:alex'),
            'response_format': 'wav'}
    r = requests.post(llm['baseUrl'].rstrip('/') + '/audio/speech',
                      headers={'Authorization': 'Bearer ' + llm['apiKey'],
                               'Content-Type': 'application/json'},
                      json=body, timeout=20)
    if r.status_code != 200:
        raise RuntimeError('TTS HTTP %s %s' % (r.status_code, r.text[:120]))
    tmp = out + '.part'
    with open(tmp, 'wb') as f:
        f.write(r.content)
    os.replace(tmp, out)
    return out


_TITLE_MEMO = []          # 已知会话名：[(canonical, key, size)]
_TITLE_MEMO_MAX = 400


def _title_key(t):
    """会话名的比较形式：只留汉字/字母/数字，去标点空格和人数后缀。"""
    return re.sub(r'[\s\W_]+', '', t or '', flags=re.UNICODE)


def _title_size(t):
    """群名末尾的人数 `(237)` —— 同一个群最硬的指纹。"""
    m = re.search(r'[（(](\d{1,4})[)）]', t or '')
    return m.group(1) if m else ''


def _stable_title(t):
    """把 OCR 抖出来的标题挂回已知的那个名字。

    会话名是归档的主键，而标题每轮都重新 OCR：「乌鲁木齐欣欣向荣大学生群四(237)」
    能读成「…群办(237)」，同一秒里 `User` 还能读成 `Liser`。名字一变，归档就多出
    一个假会话，清单里同一个群被拆成好几节（实测 14 个会话里有 5 个是同一批群的
    变体）。这里做两件事：

      1. 新名字跟已知名字相似度 ≥0.78（且人数后缀不冲突）就沿用**已知**的那个，
         不制造新键；
      2. 短名（G / ER / DHX 这类）只认完全相同，避免「ER」和「FR」互相吞掉。
    """
    t = (t or '').strip()
    if not t:
        return t
    key = _title_key(t)
    size = _title_size(t)
    if len(key) < 4:
        for c, ck, _s in _TITLE_MEMO:
            if ck == key:
                return c
        _TITLE_MEMO.append((t, key, size))
        return t
    best, best_r = '', 0.0
    for c, ck, cs in _TITLE_MEMO:
        if size and cs and size != cs:
            continue                      # 人数不同 = 另一个群
        if not ck:
            continue
        if ck == key:
            return c
        r = difflib.SequenceMatcher(None, key, ck).ratio()
        if r > best_r:
            best, best_r = c, r
    if best and best_r >= 0.78:
        return best
    _TITLE_MEMO.append((t, key, size))
    if len(_TITLE_MEMO) > _TITLE_MEMO_MAX:
        del _TITLE_MEMO[:100]
    return t


def get_chat_title(img_path, win):
    """聊天区顶部标题 = 当前会话名。

    位置用**像素**量，不用比例：标题文字固定在窗口内 (244, 22) 起，因为会话
    列表（~250px）和标题栏高度都是固定像素，不随窗口缩放。

    比例 0.36w 是当年按大窗口调的，在 892 宽的窗口里左界落在 502px，而
    **两三个字的短会话名从 427 起、到 500 就结束**，整段落在框外 → 标题读成
    空 → 监听模式直接 `title empty` 跳过整个会话，一条都不归档（真实踩到：
    「潥鱿」这个私聊在笔记里消失了）。长标题能读出来纯属右半截还在框内。

    中文名用 chi_sim 就够（比 chi_sim+eng 快 160ms）。纯英文会话名
    （File Transfer、英文昵称）chi_sim 认不准，这时再补一次 eng。
    """
    x, y, w, h = win
    box = (x + 244, y + 20, max(x + 244 + 120, x + w - 140), y + 48)
    title = re.sub(r'\s+', '', ocr_region(img_path, box, psm=7, lang='chi_sim'))
    # 第二遍（eng）只在「结果不像话」时才跑：
    #   空、或者既没有中文也没有 ASCII 字母数字 —— 那才是 chi_sim 认崩了。
    # 原来的条件是「没有中文就跑第二遍」，于是 G / FileTransfer / WeixinTeam
    # 这类纯英文名每次都要多跑一遍，白花 60~100ms，而 chi_sim 本来就把它们
    # 认对了（实测 'G'、'FileTransfer' 都一次到位）。
    if title and not re.search(r'[\u4e00-\u9fa5A-Za-z0-9]', title):
        alt = re.sub(r'\s+', '', ocr_region(img_path, box, psm=7, lang='eng'))
        if alt:
            return _stable_title(alt)
    if not title:
        alt = re.sub(r'\s+', '', ocr_region(img_path, box, psm=7, lang='eng'))
        if alt:
            return _stable_title(alt)
    return _stable_title(title)


def is_selected_row_in_strip(strip, origin, row_y):
    """在**已经抓到的会话列表条带**上判选中态，不用再单独截一张整屏。

    条带左上角在屏幕 origin，宽 x 起点正好是窗口 x+0.07w，所以行左侧背景
    就是条带的第 4 列。省下这一次整屏截图（XGetImage 约 48ms）。
    """
    ox, oy = origin
    px = strip.load()
    sx = 4
    for dy in (-8, 0, 8):
        yy = row_y + dy - oy
        if yy < 0 or yy >= strip.height:
            continue
        r, g, b = px[sx, yy]
        if g - r > 60 and g > 140:
            return True
    return False


def is_selected_row(im, win, row_y):
    """这一行是不是「当前已打开的会话」。

    判据是实测出来的：选中行左侧背景是深绿 (21,172,112)，
    未选中是灰白 (238,238,240)，g-r 差了 150，随便判都不会错。

    为什么非要知道这个：**点已经打开的那一行，微信会把聊天区弄成空白**
    （实测连点三次：第 2 次空白、第 3 次恢复），于是 open_chat 判定「点空了」
    重试一轮，白花 1.1s。而同一个人连发消息时，红点正好常出现在当前会话上，
    这条路径一点都不罕见。
    """
    x, y, w, h = win
    px = im.load()
    sx = x + int(w * 0.07) + 4          # 行最左侧、避开头像和文字
    for dy in (-8, 0, 8):
        yy = row_y + dy
        if yy < y or yy >= y + h:
            continue
        r, g, b = px[sx, yy]
        if g - r > 60 and g > 140:
            return True
    return False


def open_chat(win, row_y, tries=2, strip=None, origin=None):
    """点开指定 y 的会话行，返回 (截图, 气泡列表)。

    这里不 OCR 标题，只负责「点开 + 截图 + 扫气泡」：
    - 最后一条是我方消息时，主循环靠气泡方向就能直接跳过，省掉标题 OCR。
    - 标题 OCR 留给调用方，紧跟其后做白名单/群聊判定。

    **不要试图把标题条和气泡拼成一张图跑一次 tesseract。** 试过，能省一次
    进程启动（~320ms），但会把 ocr_band 的双阈值投票打掉：WeixinTeam 的
    服务卡片在 th=120 会把卡头「WeixinTeam」读进正文，旧路径靠 th=140 第二遍
    把它滤掉，合并后只跑一遍就把它当正文发出去了；单字符「1」也会在拼图里
    整体丢失。一次测 8 个气泡错 2 个，不值。

    **已经是当前会话就直接读，不点。** 微信里已打开的会话收到新消息会实时
    插进来，点它纯属没事找事，还会把聊天区点成空白（见 is_selected_row）。
    先截一张图判选中态，命中就省掉点击 + 0.30s 等待 + 一张截图（约 400ms）。

    点击是否生效用「聊天气泡有没有出来」判断，不靠读标题：
    窗口失焦时第一次点击会被吃掉，症状是聊天区一片空白（有气泡就是生效了）。

    切换耗时不稳：实测 135~548ms（同一个会话反复点）。所以先等 0.30s 取样，
    空就再补 0.15s 取第二次、第三次——换会话时多截两张图（每张 ~110ms）
    比判定「点空了」重新点一次（要再 activate + 点 + 等，600ms 起）便宜得多。
    """
    x, y, w, h = win
    # 先用调用方已经抓好的条带判选中态：这样「已经打开」和「需要切换」两条路
    # 都只截一次整屏，切换场景省掉一次 48ms 的 XGetImage。
    selected = False
    if strip is not None and origin is not None:
        try:
            selected = is_selected_row_in_strip(strip, origin, row_y)
        except Exception as e:
            log('选中态判断失败（忽略）：%s' % e)
    if selected:
        shot = snap()
        bands = scan_bubbles(shot, win)
        if bands:
            return shot, bands
        # 已经是当前会话，但聊天区是空的。**这时候绝不能去点它**：微信点自己
        # 那一行会把聊天区清空，而 agent 看到红点还在就又点一次，于是
        # 「点空 → 没气泡 → 再点 → 更空」死循环，CPU 直接顶到 96%（真实踩到，
        # 日志里 `open retry 2 at y=217 (no bubble)` 刷了几千行）。
        # 直接放弃这一行，交给主循环的失败冷却，等 UI 自己恢复。
        log('selected but blank chat at y=%d, skip without clicking' % row_y)
        return None, []
    for i in range(tries):
        activate_win()
        # 只等 0.10s 就取样，命中立刻返回。切换实测 135~548ms，取样点
        # 0.10 / 0.25 / 0.40 / 0.55 覆盖整个区间，快的会话不再白等 0.30s。
        click(x + int(w * 0.20), row_y, settle=0.10)
        for k in range(4):
            shot = snap()
            bands = scan_bubbles(shot, win)
            if bands:
                return shot, bands
            if k < 3:
                time.sleep(0.15)
        log('open retry %d at y=%d (no bubble)' % (i + 1, row_y))
    return None, []


def open_session(win, row_y, tries=2):
    """兼容旧接口：返回 (标题, 截图)。调试脚本在用，主循环已改用 open_chat。"""
    shot, bands = open_chat(win, row_y, tries)
    if not shot:
        return '', None
    return get_chat_title(shot, win), shot


# ---- 气泡扫描 ----
# 实测配色（WeChat 4.x Linux 默认主题）：
#   聊天背景 (250,250,250) / 我方气泡绿 (152,234,154) / 对方气泡 (238,238,240) / 水印 (224,224,224)
# 扫描 x 收到 0.41~0.95，避开左右两列头像（头像颜色不可控，会干扰判定）

CHAT_X0, CHAT_X1 = 0.41, 0.92
MSG_Y0, MSG_Y1 = 0.14, 0.775     # 字体调最大后重测：聊天区顶 ~0.147，输入框上边框 0.785


def _row_kinds(px, x0, x1, y):
    """返回 (我方绿像素数, 对方气泡像素数)"""
    g = i = 0
    for xx in range(x0, x1, 4):
        r, gg, b = px[xx, y]
        if gg - r > 40 and gg - b > 40 and gg > 200:
            g += 1
        elif 231 <= r <= 245 and abs(r - gg) <= 2 and 0 <= b - r <= 4:
            i += 1
    return g, i


def scan_bubbles(img_path, win):
    """扫聊天区，返回自上而下的气泡带 [{'y0','y1','kind'}]，kind='out' 我方 / 'in' 对方"""
    x, y, w, h = win
    x0, x1 = x + int(w * CHAT_X0), x + int(w * CHAT_X1)
    y0, y1 = y + int(h * MSG_Y0), y + int(h * MSG_Y1)
    px = _im(img_path).load()
    hits = []
    for yy in range(y0, y1):
        g, i = _row_kinds(px, x0, x1, yy)
        if g >= 4:
            hits.append((yy, 'out'))
        elif i >= 10:                    # 水印只有 1~2 个像素，10 是安全阈值
            hits.append((yy, 'in'))
    if not hits:
        return []
    bands = []
    cur = {'y0': hits[0][0], 'y1': hits[0][0], 'k': [hits[0][1]]}
    for yy, k in hits[1:]:
        # 间隔放宽到 10px：气泡中间的圆角/文字密集行偶尔会让相连几行的
        # 「对方底色像素」掉到阈值以下，把**同一个气泡裂成两半**——实测一条
        # 「OK」被记成「OK」和「和」两条（后者是尾巴的误读），等于凭空多出
        # 一条假消息。微信同一人连发两条的间距约 8px，会被合一，但内容不丢；
        # 裂开却会产生假消息，两害相权取合并。
        gap_ok = yy - cur['y1'] <= 10
        # 我方绿与对方灰不能合到一条里
        if gap_ok and cur['k'][-1] == k:
            cur['y1'] = yy
            cur['k'].append(k)
        else:
            bands.append(cur)
            cur = {'y0': yy, 'y1': yy, 'k': [k]}
    bands.append(cur)
    out = []
    for b in bands:
        if b['y1'] - b['y0'] < 8:        # 太薄，多半是分隔线残留
            continue
        kind = 'out' if b['k'].count('out') > b['k'].count('in') else 'in'
        out.append({'y0': b['y0'], 'y1': b['y1'], 'kind': kind})
    return out


def _band_x_extent(px, win, band):
    """在气泡带内找气泡的左右边界（按对方气泡色），用于紧裁，避免把大段空白喂给 OCR"""
    x, y, w, h = win
    x0, x1 = x + int(w * CHAT_X0), x + int(w * CHAT_X1)
    lo, hi = None, None
    for yy in range(band['y0'], band['y1'] + 1):
        for xx in range(x0, x1):
            r, g, b = px[xx, yy]
            hit = (231 <= r <= 245 and abs(r - g) <= 2 and 0 <= b - r <= 4) or \
                  (g - r > 40 and g - b > 40 and g > 200)
            if hit:
                if lo is None or xx < lo:
                    lo = xx
                if hi is None or xx > hi:
                    hi = xx
    return lo, hi


def _prep(crop, scale, thresh=120):
    """放大 + 灰度阈值二值化。我方绿底(152,234,154)与对方灰底(238,238,240)
    转灰度后分别是 200 / 238，黑字约 30~60，阈值 120 能把底色全部抹成白，
    避免底色吃掉笔画。抽出来是为了让「标题+消息」拼图时两边处理完全一致。"""
    from PIL import Image
    c = crop.resize((crop.width * scale, crop.height * scale), Image.LANCZOS).convert('L')
    return c.point(lambda v: 255 if v > thresh else 0)


def _ocr_bin(crop, scale, thresh=120, lang='chi_sim+eng'):
    """二值化后 OCR。

    语言包保留 chi_sim+eng：纯 chi_sim 对数字不敏感，
    单字符消息「1」会被认成「工」（实测踩过）。慢 200ms 换准确率。

    走常驻实例（ocr_img），不再存盘起进程：这里原本是整个链路上最贵的一步，
    现在只剩纯识别时间。
    """
    return ocr_img(_prep(crop, scale, thresh), psm=6, lang=lang)


def _cn_score(t):
    """评分：中文字数 - 大写字母数。
    误识别结果典型特征是成串大写拉丁字母（MAR BCS S 之类），要扣分。"""
    cn = sum(1 for ch in t if '\u4e00' <= ch <= '\u9fa5')
    bad = sum(1 for ch in t if 'A' <= ch <= 'Z')
    return cn - bad


# 干净结果的字符白名单：汉字、字母数字、中英文标点、空白
_CLEAN_RE = re.compile(r'^[\u4e00-\u9fa5A-Za-z0-9，。！？、；：“”‘’（）《》…—～?!.,:;\s]+$')
# 行首「1~2 个字母 + 符号」几乎都是气泡边缘被误读（j] 你好 / j 1），算脏
_LEAD_NOISE_RE = re.compile(r'^[A-Za-z]{1,2}[^A-Za-z0-9\u4e00-\u9fa5]')


def _tidy(t):
    """规范化 OCR 原文：去多余空格、行首噪声、标点前空格、尾部垃圾。

    必须放在「判断干净」之前——否则 '嗨，你好呀，最近咋样 ?' 会因为
    问号前那个空格被判成脏，白跑一次 tesseract（实测多花 1s）。
    """
    t = re.sub(r'\s+', ' ', t or '').strip()
    # 行首的框线/引号噪声（截图边缘常被识别成 | ” 等）
    t = re.sub(r'^[^\u4e00-\u9fa5A-Za-z0-9]+', '', t).strip()
    # 中文标点前不该有空格（'最近咋样 ?' -> '最近咋样?'）
    t = re.sub(r'\s+([，。！？、；：？！?!])', r'\1', t)
    # 换行处被塞进孤立的冒号/竖线（气泡小尾巴）
    t = re.sub(r'\s+[:;|]\s+', '', t)
    # 尾部噪声
    t = re.sub(r'[\s:;|"\'`~_\\/=+*<>\[\]{}]+$', '', t).strip()
    return t


def _clean_enough(txt):
    """结果够干净就不用再跑第二种阈值。

    这一条把「永远跑 2~3 次 tesseract」变成「多数只跑 1 次」：
    干净的收工，脏的才补一次，再按中文密度选优。
    """
    t = txt.strip()
    if not t or _LEAD_NOISE_RE.match(t):
        return False
    return bool(_CLEAN_RE.match(t))


def _cn_density(t):
    """中文密度，用来在两次 OCR 结果间选优：
    「你好」1.0 胜过「j] 你好」0.4；纯数字/英文都是 0，交给「更短优先」决胜。"""
    s = re.sub(r'\s+', '', t)
    if not s:
        return -1.0
    cn = sum(1 for ch in s if '\u4e00' <= ch <= '\u9fa5')
    return cn / len(s) if cn else 0.0


# 微信自己的 UI 文字，被 OCR 当成消息正文读进来的：
#   「查看更多」按钮渲染成 `More` / `...More`，链接卡片和位置卡片的预览
#   （`地址定位信息`、`省市区: …`）也挂在气泡里。这些不是对方说的话，
#   留在正文里会让清单把「点击查看链接」提炼成一条待办（真实出现过）。
_UI_TAIL_RE = re.compile(r'(?:\.{2,}|…)?\s*(?:More|链接文本|查看更多)\s*$', re.I)
_UI_ONLY_RE = re.compile(r'^(?:(?:点击|查看|打开)?(?:地址)?定位信息'
                         r'|(?:省市区|地址|电话)\s*[:：].*'
                         r'|\[?查看更多\]?.*)$')
# 剥掉 UI 尾巴之后残留在句末的符号（`…More` 剥完还剩个点）
_TAIL_JUNK = ' \t.…·、,，。:：-—'


def _scrub_ui(t):
    """剥掉 UI 噪声，剩下的才是人说的话。

    实测脏样本（真实群聊归档里抄下来的）：
      `WE 罗天山区家教订.More`  → `WE 罗天山区家教订`
      ``...More链接文本``        → 整条丢弃
      `地址定位信息`             → 整条丢弃
      `ROSAS ACT LB A`          → 整条丢弃（全大写拉丁噪声，中文字数是 0）

    尾巴要**循环剥**：`...More链接文本` 一次只剥掉「链接文本」，前面还剩
    `...More`，不循环就会留一段垃圾（单测里抓到过）。
    """
    if not t:
        return ''
    lines = []
    for ln in re.split(r'[\n\r]+', t):
        ln = ln.strip()
        if not ln:
            continue
        before = ln
        while True:
            nxt = _UI_TAIL_RE.sub('', ln).strip()
            if nxt == ln:
                break
            ln = nxt
        if ln != before:
            ln = ln.strip(_TAIL_JUNK)
        if not ln or _UI_ONLY_RE.match(ln):
            continue
        lines.append(ln)
    t = ' '.join(lines).strip()
    if not t:
        return ''
    # 全大写拉丁串（≥6 个大写字母、零中文）是笔画误读的典型形态：
    # `ROSAS ACT LB A`、`AL XS8A726110201P`。真英文消息几乎不会全大写，
    # 而小写混排的 `okok` / `Hello world` 不受影响。
    cn = sum(1 for ch in t if '\u4e00' <= ch <= '\u9fa5')
    up = sum(1 for ch in t if 'A' <= ch <= 'Z')
    if cn == 0 and up >= 6:
        return ''
    return t


def _text_bbox(im, win, band, dark=150):
    """在气泡带里按「暗像素」找文字的真实边界。

    一举两得：
      1. 气泡左下/右下那个小尾巴和底色同色，会被 _band_x_extent 算进边界，
         OCR 常把它认成句首的「和」「|」（日志里真出现过
         `incoming=和 如果遇到问题…`）。按暗像素裁就自动把尾巴排除。
      2. 裁剪面积按文字实际大小收，tesseract 耗时正比于像素数，跟着降。

    返回 (lo, hi, top, bot)；找不到文字返回 None，由调用方回退。
    """
    x, y, w, h = win
    x0, x1 = x + int(w * CHAT_X0), x + int(w * CHAT_X1)
    px = im.load()
    y0, y1 = band['y0'], band['y1']
    lim = dark * 3
    lo = hi = None
    for xx in range(x0, x1):
        n = 0
        for yy in range(y0, y1 + 1, 2):
            r, g, b = px[xx, yy]
            if r + g + b < lim:
                n += 1
        if n >= 2:
            if lo is None:
                lo = xx
            hi = xx
    if lo is None:
        return None
    top = bot = None
    for yy in range(y0, y1 + 1):
        n = 0
        for xx in range(lo, hi + 1, 2):
            r, g, b = px[xx, yy]
            if r + g + b < lim:
                n += 1
        if n >= 2:
            if top is None:
                top = yy
            bot = yy
    if top is None:
        return None
    return lo, hi, top, bot


def _bubble_rect(im, win, band, pad=3):
    """把一条气泡带裁成「只有气泡本身」的图像；找不到气泡返回 None。

    **按暗像素找边界是错的。** 对方头像就在气泡左侧约 14px，且是深色的
    （狗头 emoji 棕 (203,160,105) + 外圈深灰），一定满足 dark 阈值，于是
    扫描起点落在头像上。线上真实后果：对方发「快点」被认成 `J aebUR`、
    「发个照片」被认成 `SNARE`，模型只能回「没看懂」——这就是那条 bug 的根。

    实测像素（917 宽窗口，「发个照片」那一行）：
        x=348~386  头像（深灰 + 棕）
        x=388~396  聊天背景 (250,250,250)   <- 头像与气泡之间必有 14px 纯背景
        x=400~548  气泡底色 (238,238,240)

    所以「中心线上最长的连续非背景列段」就是气泡：不写死任何坐标，也不怕
    换主题色；短消息「嗯」约 60px，仍长于 38px 的头像，不会被误判成头像。
    """
    x, y, w, h = win
    px = im.load()
    # 垂直范围要比 band 宽一圈：scan_bubbles 是「每行灰色像素 >= 10」才算气泡行，
    # 气泡底部圆角处像素数掉到 10 以下，band 的下沿就提前收尾，文字下半截被裁掉。
    # 实测「发个照片」只留上半部分，tesseract 把「发」认成「必」、「照」认成「昭」。
    # 上下各放一点，但不超过消息区底边（h*0.80 是输入框上方）。
    sy0 = max(band['y0'] - 8, y)
    sy1 = min(band['y1'] + 14, y + int(h * 0.80))
    mid = (sy0 + sy1) // 2
    xa, xb = x + int(w * 0.30), x + int(w * 0.97)
    # 背景色取整行众数，不能取某一个点：那一点可能正好落在分隔线、头像
    # 或气泡上（实测 x+0.28w 就踩到会话列表右边缘），取错一次整条链路全废
    # ——气泡底色反而被当成「背景」，段被切碎，crop 宽到 581px。
    from collections import Counter
    bg = Counter(px[xx, mid] for xx in range(xa, xb)).most_common(1)[0][0]

    def is_bg(c):
        return (abs(c[0] - bg[0]) <= 3 and abs(c[1] - bg[1]) <= 3
                and abs(c[2] - bg[2]) <= 3)

    # 只扫中心行附近 3 行：气泡底色在行间空隙也是非背景，不会漏；
    # 700 列 x 3 行约 2ms，比全带扫描（14000 次）便宜一个数量级。
    rows = [r for r in (mid - 3, mid, mid + 3) if sy0 <= r <= sy1]
    flags = []
    for xx in range(xa, xb):
        hit = False
        for yy in rows:
            if not is_bg(px[xx, yy]):
                hit = True
                break
        flags.append(hit)

    best_s, best_e = -1, -1
    s = None
    for i, f in enumerate(flags):
        if f and s is None:
            s = i
        elif not f and s is not None:
            if i - s > best_e - best_s + 1:
                best_s, best_e = s, i - 1
            s = None
    if s is not None and len(flags) - s > best_e - best_s + 1:
        best_s, best_e = s, len(flags) - 1
    if best_s < 0 or best_e <= best_s:
        return None
    lo, hi = xa + best_s, xa + best_e

    # 垂直方向同样收紧到气泡本身（band 可能把头像的上下延伸也算进来）
    top = bot = None
    for yy in range(sy0, sy1 + 1):
        n = 0
        for xx in range(lo, hi + 1, 3):
            if not is_bg(px[xx, yy]):
                n += 1
        if n >= 2:
            if top is None:
                top = yy
            bot = yy
    if top is None:
        top, bot = sy0, sy1

    crop = im.crop((max(lo - pad, 0), max(top - pad, 0),
                    min(hi + pad, im.width), min(bot + pad, im.height)))
    if crop.width < 8 or crop.height < 8:
        return None
    return crop


def _band_is_picture(crop):
    """这条气泡是不是图片/表情包，而不是文字。

    对方发表情包时，OCR 会对着图里的线条乱认，日志里那些 `RE`、`mae`、
    `J aebUR` 有一半是这么来的（另一半是裁到头像）。模型收到乱码只能回
    「没看懂」。判成图片后换成一句占位描述，模型就知道「对方发了个表情」。

    判据是颜色多样性：文字气泡只有 2~3 种颜色（底色 + 文字色，抗锯齿算过渡色），
    图片/表情有几十上百种。量化到 32 级再数，文字 < 8，表情 > 20，中间有条安全区。
    """
    try:
        small = crop.resize((min(crop.width, 64), min(crop.height, 64)), Image.NEAREST)
    except Exception:
        return False
    colors = set()
    for c in small.getdata():
        colors.add((c[0] >> 5, c[1] >> 5, c[2] >> 5))
    return len(colors) > 20


def _band_crop(im, win, band, pad=6):
    """把一个气泡带紧裁成文字图像。找不到气泡退回旧几何；返回 None 表示太小。"""
    crop = _bubble_rect(im, win, band, pad=3)
    if crop is not None:
        return crop
    x, y, w, h = win
    tb = _text_bbox(im, win, band)
    if tb:
        lo, hi, top, bot = tb
    else:
        lo, hi = _band_x_extent(im.load(), win, band)
        if lo is None:
            lo, hi = x + int(w * 0.40), x + int(w * 0.94)
        top, bot = band['y0'], band['y1']
    crop = im.crop((max(lo - pad, 0), max(top - pad, 0), hi + pad, bot + pad))
    if crop.width < 8 or crop.height < 8:
        return None
    return crop


def ocr_band(img_path, win, band, pad=6):
    """对单个气泡带做 OCR。

    阈值实测（同一批气泡穷举 4 组参数）：th=120 全面优于 th=140——
    「嗨，你好呀」在 140 下认成「路，你好呀」，「1」认成「] 1」，120 全对。
    所以 120 是首选，140 只做兜底。

    策略是「结果干净就一次收工」，脏了才补跑 140 并按中文密度选优：
    单条消息从旧版固定 2~3 次（1.5~1.7s）降到多数 1 次（0.5~1.0s）。
    """
    im = _im(img_path)
    crop = _band_crop(im, win, band, pad)
    return ocr_crop(crop)


def ocr_crop(crop):
    """对已经裁好的 PIL 图跑同一套双阈值 OCR（监听模式的宽裁图也走这里）。"""
    if crop is None:
        return ''
    best, best_d = '', -1.0
    # 第一遍用**原图 1 倍**：字体调到最大之后，原始字号对 tesseract 已经够大
    # （>=20px），再放大只会在笔画边缘产生振铃，二值化后变成光晕。
    # 实测同一批气泡（4 个，psm6 / chi_sim+eng）：
    #   1.0 LANCZOS  602ms   ''/ale/你说的是哈/不好意思，没看懂
    #   2.0 LANCZOS 1033ms   xs fae/Ralls/PIR/不好意思 NAN 9 Ralls   <- 原方案
    #   2.0 NEAREST  654ms   ''/nals/PIR WIS/不好意思，疫看懂
    # 1 倍既快一倍又更准。第二遍保留成 2 倍 + th=140 的老参数：它是当年
    # 用来滤掉 WeixinTeam 服务卡片卡头的那个组合，结果脏的时候靠它投票。
    for scale, th in ((1, 120), (2, 140)):
        raw = _ocr_bin(crop, scale, th)
        txt = _tidy(' '.join(re.sub(r'\s+', ' ', l).strip() for l in raw.splitlines() if l.strip()))
        if not txt:
            continue
        d = _cn_density(txt)
        # 平手时取更短的：噪声总是额外字符（'] 1' 对 '1'）
        if d > best_d or (d == best_d and len(txt) < len(best)):
            best, best_d = txt, d
        if _clean_enough(txt):
            break
    return best


def _ocr_loose(crop):
    """最后一道 OCR：放大 3 倍 + 放宽阈值。

    只在前两遍都读空时跑，专门救「灰色多行气泡 / 小字号 / 带背景水印」这类
    `ocr_crop` 全灭的情况。代价 0.4~0.9s，但只发生在原本要落成 `[文字]`
    （正文一个字都不剩）的气泡上——实测归档里 58 条有 5 条这样，全是白白丢的。
    """
    if crop is None:
        return ''
    try:
        raw = _ocr_bin(crop, 3, 160)
    except Exception:
        return ''
    txt = _tidy(' '.join(re.sub(r'\s+', ' ', l).strip() for l in raw.splitlines() if l.strip()))
    txt = _scrub_ui(txt)
    if not txt:
        return ''
    # 宽松通道只要求「看着像话」：有连续汉字，或者中文密度不太低。
    # 不再要求 _CLEAN_RE 全白名单——正是它把灰色气泡判死的。
    if re.search(r'[\u4e00-\u9fa5]{2}', txt) or _cn_density(txt) >= 0.35:
        return txt
    return ''


def get_last_messages(img_path, win, n=3):
    """返回最后 n 条消息文本（只取对方发的）"""
    bands = scan_bubbles(img_path, win)
    texts = []
    for b in reversed(bands):
        if b['kind'] != 'in':
            continue
        t = ocr_band(img_path, win, b)
        if t:
            texts.append(t)
        if len(texts) >= n:
            break
    return list(reversed(texts))

# ---------- 只收不发：气泡分类 / 截图留档 / 全量归档 ----------

_KIND_LABEL = {
    'text': '文字', 'image': '图片', 'sticker': '表情包', 'voice': '语音条',
    'video': '视频', 'file': '文件', 'media': '媒体消息'
}


def _obs_inbox(ts):
    d = os.path.join(OBS_INBOX, _day_of(ts), 'wx')
    os.makedirs(d, exist_ok=True)
    return d


def _obs_index(ts):
    return os.path.join(_obs_inbox(ts), 'media-index.jsonl')


def _obs_crops(im, win, band):
    """监听模式的两张裁剪（宽裁, 紧裁），宽裁是主力，紧裁只做 OCR 兜底。

    **不要再把紧裁当主力**。`_bubble_rect` 靠「中心线最长连续非背景段」找
    左右边界，对单行白底气泡没问题，但多行灰气泡和卡片上会给出 124px 宽的
    竖条（实测：真实聊天里 41 条消息全被裁成这样），OCR 只读到半行甚至读空，
    于是全部落进「非文字」分支 —— 这是「消息内容丢失」的第二个根因。

    消息列在窗口里是固定的一竖条（头像右侧到窗口右缘），按窗口比例取整条
    反而稳：实测同一屏 4 条气泡，宽裁 OCR 读出了完整的长段招聘文字，紧裁
    读空。宽裁多带一点空白不影响 OCR，多花的那几毫秒比丢内容划算。
    """
    x, y, w, h = win
    # 左界用**像素**，不用比例。微信的会话列表（~250px）和头像列（36px + 间距）
    # 都是固定像素宽，不随窗口缩放：窗口 892 时气泡正文从窗口内 ~308px 起，
    # 窗口 1200 时也在 ~308px。原来写比例 0.33，在 892 下正好切进气泡开头
    # （归档里「师) 180/2h 女老师…」缺的就是「老」），在 1200 下又多带 50px
    # 头像进画面 —— OCR 把头像读成 `AT RS «J ATA` 那种噪声。
    # 352 = 气泡左缘（窗口内像素，与会话列表/头像一样是固定宽度不随窗口缩放）。
    # 280 会把左侧头像整个带进来，OCR 把头像读成 `AT RS «J ATA` 这种噪声。
    x0 = max(x + 352, 0)
    x1 = min(x + w - 8, im.width)
    y0 = max(band['y0'] - 8, y)
    y1 = min(band['y1'] + 14, y + int(h * 0.80), im.height)
    wide = None
    if x1 - x0 >= 60 and y1 - y0 >= 10:
        wide = im.crop((x0, y0, x1, y1))
    tight = _band_crop(im, win, band)
    if tight is not None:
        tw, th = tight.size
        if tw < 20 or th < 10 or tw * th > 400000:
            tight = None
    return wide, tight


def _obs_crop(im, win, band):
    """兼容旧调用：只要一张就给宽裁。"""
    wide, tight = _obs_crops(im, win, band)
    return wide or tight


def _band_shape(crop):
    """气泡里「真正有内容」那块的宽高，用来判形状。

    不能直接拿 `crop.size`：卡片消息会被 `_obs_crop` 退回宽裁，宽裁的宽度
    就是小半个聊天区，任何气泡放进去都成了「细长横条」，于是全部判成语音条。
    这里先取四条边框的灰度众数当背景色，再用 `point` + `getbbox` 找非背景
    像素的外接框（`point` 只跑 256 次 LUT，比逐像素 Python 循环快两个数量级）。
    """
    try:
        g = crop.convert('L')
        w, h = g.size
        px = g.load()
        cnt = {}
        sx = max(1, w // 32)
        sy = max(1, h // 32)
        for x in range(0, w, sx):
            for yy in (0, h - 1):
                v = px[x, yy] // 8
                cnt[v] = cnt.get(v, 0) + 1
        for y in range(0, h, sy):
            for xx in (0, w - 1):
                v = px[xx, y] // 8
                cnt[v] = cnt.get(v, 0) + 1
        if not cnt:
            return w, h
        bg = max(cnt.items(), key=lambda kv: kv[1])[0] * 8
        bb = g.point(lambda v: 255 if abs(v - bg) > 18 else 0).getbbox()
        if not bb:
            return w, h
        bw, bh = bb[2] - bb[0], bb[3] - bb[1]
        if bw < 6 or bh < 6:
            return w, h
        return bw, bh
    except Exception:
        return crop.size


def _band_kind_shape(crop):
    """OCR 读不出字时，按内容块的形状猜是语音条/文件/其他。"""
    if crop is None:
        return 'media'
    bw, bh = _band_shape(crop)
    ratio = float(bw) / max(bh, 1)
    if ratio > 2.6 and bh < 80:
        return 'voice'
    if ratio > 1.5 and bh >= 60:
        return 'file'
    return 'media'


def _band_read(crops):
    """读一个气泡：返回 (kind, text)。**先 OCR，再分类**。

    旧版反过来（先判形状，只有 `text` 才跑 OCR），真实聊天里形状判据几乎全错：
    实测「okok」被判成文件、「以后还找你」被判成视频、一堆纯文字被判成语音条。
    而错判的代价是**正文彻底丢失**——非 text 分支不跑 OCR，归档里只剩一个
    `[文件]`，用户要的「只存文字」直接落空。

    所以顺序改成：OCR 读得出干净文本 → 就是文字；读不出来才按图/形状归类。
    代价是「带文字的图片/文件卡片」会被记成文字，但正文留住了，比丢正文划算。

    `crops` 可以是单张图，也可以是 (宽裁, 紧裁)：宽裁先跑（读数更全），
    不出字再用紧裁补一刀，两刀都空才认它是媒体。
    """
    cands = crops if isinstance(crops, (list, tuple)) else [crops]
    cands = [c for c in cands if c is not None]
    if not cands:
        return 'media', ''
    # 短气泡改用紧裁优先。紧裁的高度明显小于宽裁（宽裁固定多带 8+14px 留白）
    # 时，说明这次紧裁是**真的贴着文字**的——左右边距清晰、不会切字，而宽裁
    # 上下那圈留白会把相邻行的笔画残影读进来（实测「OK」被读成「了 OK 有」）。
    # 长气泡反过来：紧裁这时往往是 124px 宽的竖条，必须靠宽裁。
    if len(cands) == 2:
        wide, tight = cands[0], cands[1]
        if tight.height <= wide.height * 0.55 and tight.width >= 40:
            cands = [tight, wide]
    for crop in cands:
        txt = _scrub_ui(ocr_crop(crop))
        if not txt:
            continue
        bare = re.sub(r'\s+', '', txt)
        if bare and (_CLEAN_RE.match(txt) or _cn_density(txt) >= 0.6):
            return 'text', txt
    # 读不出字：先看是不是图（颜色多样性），再退回形状
    base = cands[0]
    if _band_is_picture(base):
        bw, bh = _band_shape(base)
        if bw < 170 and bh < 170:
            return 'sticker', ''
        if float(bw) / max(bh, 1) > 1.6 and bh < 160:
            return 'video', ''
        return 'image', ''
    # 不是图，却两遍都没读出干净文本 —— 这是「文字气泡的 OCR 失败」，
    # 也是最亏的一种：正文一个字不剩，归档里只剩一个 [文字]。放宽容错再救一次。
    for crop in cands:
        loose = _ocr_loose(crop)
        if loose:
            return 'text', loose
    return _band_kind_shape(base), ''


def _clean_sender(t):
    """清洗昵称行的 OCR 结果，判不出来就返回 ''（调用方沿用上一条）。

    实测脏样本：`PMHApril14th`（上一行时间戳的 PM 黏了上来）、`emer`（只读到
    尾巴）、`Aprill4th`（多一个 l）。昵称行是浅灰小字，本身就容易读坏，而
    一个错名字比空名字更糟——群里会把别人的话记到错的人头上。
    """
    t = re.sub(r'\s+', '', _tidy(t or ''))
    if not t:
        return ''
    # 时间戳前缀（群聊里昵称行左侧偶尔会带上时间）
    t = re.sub(r'^(?:[AP]M|上午|下午|凌晨|中午|晚上|昨天|今天|前天)', '', t, flags=re.I)
    t = re.sub(r'^\d{1,2}[:：]\d{2}', '', t)
    t = t.strip('·.,，。:：')
    # 昵称 2~14 字。超长基本是把正文读进来了。
    if len(t) < 2 or len(t) > 14:
        return ''
    if not re.search(r'[\u4e00-\u9fa5A-Za-z0-9]', t):
        return ''
    cn = sum(1 for ch in t if '\u4e00' <= ch <= '\u9fa5')
    if cn == 0:
        # 纯拉丁/数字昵称：中间夹连续大写（`HApril14th`）或太短（`em`）都判脏。
        # 长度 3 以上的全小写放行（`emer` 可能就是人家昵称的尾巴，删了更糟）。
        if re.search(r'[A-Z]{2}', t):
            return ''
        if len(t) < 3:
            return ''
    return t


def _band_sender(im, win, band, prev=''):
    """群聊里这条气泡是谁说的：读气泡上方那行浅灰昵称。

    微信群聊只有「换人之后的第一条」头顶带昵称，同一个人连发时后面的气泡
    没有这一行。所以识别不出来时必须沿用上一条的发送者（prev），否则一次
    连发全被记成无名氏，消息库里的群聊就退化成一大段分不清谁的话。

    门控：昵称是 #B2B2B2 左右的浅灰，正文是近黑。区域里没有浅灰像素就直接
    返回，不白花一次 tesseract —— 群里一次十几条气泡，每条多 100ms 扛不住。

    **昵称行的位置不能靠「band 上方固定 20px」猜**：`band['y0']` 是扫描时第一个
    有暗像素的行，不是气泡顶边，实测比气泡顶低十几像素，按固定偏移裁到的是正文
    第一行的上半截（裁出来的图里就是「科目@数学」的下半截，见 _sd_0.png）。
    改成在 band 上方 44px 里**找浅灰行**：昵称 178 落在 150~215，正文近黑，
    气泡底色 237 落在区间外。
    """
    x, y, w, h = win
    # 左界用像素而不是比例：会话列表是固定像素宽（~250px），比例 0.17 在 892
    # 宽的窗口里只到窗口内 151px，整个落在**会话列表内部**——实测读出来的是
    # 会话列表里的「pinned chats」和别人的头像，再加一段正文。群聊 sender 因此
    # 长期是空的（或者记成「pinned chats」这种鬼东西）。300 是气泡左缘，
    # 和 `_obs_crops` 宽裁用同一个基准。
    # 382 = 昵称左缘：昵称相对气泡还有约 30px 缩进，头像在 335~380。
    # 用 300 会把头像拉进来，浅灰行匹配到的是头发的灰，OCR 出来全是乱码。
    x0 = max(x + 382, 0)
    x1 = min(x + 582, im.width)       # 昵称不会超过 200px
    if x1 - x0 < 30:
        return prev
    top = max(band['y0'] - 44, y)
    bot = max(band['y0'] - 2, top + 1)
    if bot - top < 7:
        return prev
    try:
        g = im.crop((x0, top, x1, bot)).convert('L')
        px = g.load()
    except Exception:
        return prev
    rows = []
    for ry in range(g.height):
        grey = dark = 0
        for rx in range(0, g.width, 2):
            v = px[rx, ry]
            if 150 <= v <= 215:
                grey += 1
            elif v < 120:
                dark += 1
        rows.append((grey, dark))
    # 昵称行：有像样的浅灰像素，且几乎没有深色（深色的是正文）
    cand = [i for i, (gr, dk) in enumerate(rows) if gr >= 5 and dk <= max(2, gr // 4)]
    if not cand:
        return prev
    # 取离气泡最近的那一组连续行（昵称就在正文正上方，别把上一条消息的
    # 「时间戳」「系统提示」也拉进来）
    end = cand[-1]
    start = end
    while start - 1 in cand:
        start -= 1
    cy0 = top + max(start - 2, 0)
    cy1 = top + min(end + 3, g.height)
    try:
        crop = im.crop((x0, cy0, x1, cy1))
    except Exception:
        return prev
    try:
        t = ocr_img(_prep(crop, 2, 215), psm=7, lang='chi_sim+eng')
    except Exception:
        return prev
    t = _clean_sender(t)
    # 判不出人名就沿用上一条：群聊里同一个人连发时，后面几条头顶本来就没有昵称，
    # 沿用上一条是对的；读坏了硬记一个错名字，等于把话记到别人头上。
    if not t:
        return prev
    return t


def _band_fingerprint(crop):
    """裁剪图缩成 12x12 灰度的指纹，用来判重（同一次红点被扫多遍）。"""
    try:
        g = crop.convert('L').resize((12, 12), Image.BILINEAR)
        return hashlib.md5(bytes(g.getdata())).hexdigest()[:12]
    except Exception:
        return ''


def _obs_shot(crop, ts, title, idx, kind):
    """把这条气泡存成 PNG，返回相对 OBS_INBOX 根的路径。"""
    if crop is None:
        return ''
    try:
        safe = re.sub(r'[^\w\u4e00-\u9fff.-]', '_', title)[:20]
        name = '%s_%d_%02d_%s.png' % (safe, ts, idx, kind)
        crop.save(os.path.join(_obs_inbox(ts), name))
        return os.path.join(_day_of(ts), 'wx', name).replace('\\', '/')
    except Exception as e:
        log('obs shot fail: %s' % e)
        return ''


def _obs_seen_load(st):
    seen = st.setdefault('obsSeen', {})
    now = time.time()
    for k in list(seen):
        if now - seen[k] > OBS_SEEN_WINDOW:
            del seen[k]
    return seen


def _dedup_keys(title, kind, text, fp):
    """一条消息的去重键，返回 1~2 个，任一命中就跳过。

    只用图指纹会漏：宽裁图包含整条消息列宽，band 的 y 上下浮动一两像素就换一个
    指纹，同一条消息在下一轮扫描时被当成新的重复归档——实测 58 条里 11 条重复，
    全是这个原因。正文对同一条消息稳定得多，所以文字再按正文算一个键，
    两个都查、两个都记。
    """
    keys = ['%s|f|%s' % (title, fp)]
    if kind == 'text' and text and not text.startswith('['):
        # 只留汉字和数字：同一条消息两次 OCR 的差别几乎都在两头的拉丁噪声上
        # （`We' 乌鲁木齐26111032//简历…` 和 `乌鲁木齐26111032//简历…` 是同一条，
        # 留着 We 就判成两条，实测 16 秒内重复归档了一次）。
        # 纯英文消息算出来是空，就不生成正文键，退回图指纹。
        body = re.sub(r'[^\u4e00-\u9fa5\d]+', '', text)
        if len(body) >= 4:
            keys.append('%s|t|%s' % (
                title, hashlib.md5(body.encode('utf-8')).hexdigest()[:16]))
    return keys


def observe_chat(im, win, bands, title, st):
    """监听模式处理一个会话：把屏幕上所有对方气泡逐条归档 + 留截图。

    不调模型、不发送、不看白名单、不进冷却。返回新增条数。
    """
    ins = [b for b in bands if b.get('kind') == 'in'][-OBS_MAX_BANDS:]
    if not ins:
        return 0
    seen = _obs_seen_load(st)
    now = int(time.time())
    added = 0
    kinds = []
    # 群聊要记「谁说的」。上次的发送者存在 state 里：新一轮扫描时，同一个人
    # 连发的后续气泡头顶已经没有昵称了，只能靠这份记忆接上。半小时内有效，
    # 隔太久换人说话时不该沿用。
    group = is_group_chat(title)
    sb = st.setdefault('obsSender', {})
    prev = sb.get(title) or ['', 0]
    sender = prev[0] if now - int(prev[1] or 0) < 1800 else ''
    for idx, b in enumerate(ins):
        # 宽裁 + 紧裁两张都给 `_band_read`：宽裁读数更全，紧裁补漏。
        crops = _obs_crops(im, win, b)
        kind, text = _band_read(crops)
        if not text:
            text = '[%s]' % _KIND_LABEL.get(kind, '媒体消息')
        crop = crops[0] or crops[1]
        fp = _band_fingerprint(crop) or ('%s|%s' % (kind, text))
        keys = _dedup_keys(title, kind, text, fp)
        if any(k in seen for k in keys):
            continue
        for k in keys:
            seen[k] = now
        # 同一轮扫出来的一屏消息，秒级时间戳全一样，清单里排序和「几点发的」
        # 都会乱。按气泡从上到下的顺序每条 +1 秒，顺序就对了。
        ts = now + idx
        if group:
            sender = _band_sender(im, win, b, sender)
        # 文字消息不留截图：用户要的是「只存文字」，正文已经在 OCR 结果里，
        # 再存一张图纯占空间，还会把一堆「文字截图」灌进素材库（真实发生过，
        # 22 条素材全是 chat 截图）。只有读不出字的媒体才截。
        shot = '' if kind == 'text' else _obs_shot(crop, ts, title, idx, kind)
        # 截图路径直接写在归档行的 shot 字段里，清单生成器按它取图。
        # **不要再写一份 media-index**：那样同一个文件会被复制两次、清单里
        # 同一张图出现两遍。QQ 才需要索引（它的媒体是独立下载的一堆文件）。
        rec = {'src': 'wx', 'k': kind, 'shot': shot, 'mid': fp,
               'sn': sender if group else '',
               'm': [{'t': kind, 'u': '', 'n': _KIND_LABEL.get(kind, '媒体消息')}]}
        if arc_append(title, text, me=False, kind=kind, ts=ts, extra=rec):
            added += 1
            kinds.append(_KIND_LABEL.get(kind, kind))
    if group and sender:
        sb[title] = [sender, now]
    if added:
        save_state(st)
        log('observe %s: +%d 条 (%s)' % (title, added, ', '.join(kinds)))
    return added


def read_incoming(im, win, bands, max_n=3):
    """读「对方刚发来的一串消息」，从最新往前取最多 max_n 条连续气泡。

    旧版只读 bands[-1]，等于只看最后一句。对方连发「发个语音」「快点」
    「发个照片」时，模型只收到「发个照片」，前面全丢；而「快点」这种两字
    消息脱离上下文本来就没法懂，模型只能回「没看懂」——线上原话。

    只取**连续**的对方气泡：遇到我方气泡就停，那是上一轮的边界。
    """
    texts = []
    for b in reversed(bands):
        if b['kind'] != 'in':
            break
        crop = _band_crop(im, win, b)
        if crop is not None and _band_is_picture(crop):
            # 不能对图片跑 OCR：图里的线条会被认成字母，模型只看到乱码。
            texts.append('[对方发了一张图片/表情]')
        else:
            t = ocr_band(im, win, b)
            if t:
                texts.append(t)
        if len(texts) >= max_n:
            break
    texts.reverse()
    return '\n'.join(texts)


# 上下文在文件里（见本文件顶部的 arc_append / hist_text）。
# **这里曾经是个进程内字典 `_HIST`**：一重启就清零，模型又退回「只看到一句话」，
# 短消息必然听不懂。落盘之后重启无损，也不再受进程生命周期影响。


def main_loop():
    cfg = load_cfg()
    st = load_state()
    log('agent start, mode=%s whitelist=%s model=%s poll=%.2fs' % (
        'OBSERVE(只收不发)' if cfg.get('observeOnly') else 'REPLY(自动回复)',
        cfg['whitelist'], cfg['llm']['model'], cfg['pollInterval']))
    # 监听模式不调模型，apiKey 是每日清单生成器（宿主机）才需要的。
    if not cfg.get('observeOnly') and not cfg['llm']['apiKey']:
        log('FATAL: llm.apiKey 未配置')
        return
    last_list_hash = None
    win = None
    tick = 0
    wait = cfg['pollInterval']
    # 预热常驻 OCR：每个语言实例第一次 init 要 ~340ms（加载 chi_sim 的 dawg 词库），
    # 不预热的话这笔开销会落到「第一条消息」的响应时间里。
    # 标题用 chi_sim、正文用 chi_sim+eng，是两个独立实例，两个都要热。
    for _lang in ('chi_sim', 'chi_sim+eng'):
        _tess_api(_lang)
    if _tess_lib():
        log('常驻 OCR 就绪（%s）' % ', '.join(k for k, v in _TESS_APIS.items() if v))
    while True:
        try:
            time.sleep(wait)
            # 窗口几何基本不动，20 轮刷一次就够（每轮省 24ms 的 xdotool）
            if win is None or tick % 20 == 0:
                win = win_geometry()
            tick += 1
            if not win or win[2] < 500:
                win = None                       # 未登录/窗口未就绪
                wait = cfg['pollInterval']
                continue
            x, y, w, h = win

            # 轮询只抓会话列表那条竖带（246x680），不再抓整屏：
            # 整屏 XGetImage 要 30~48ms，条带只要 3~5ms。这是能把轮询间隔
            # 从 0.8s 压到 0.3s 的前提——**感知延迟 = 轮询间隔 + 处理耗时**，
            # 内部再快，等 0.8s 才发现新消息也是白搭。
            lbox = (x + int(w * 0.07), y, int(w * 0.27), h)
            strip = snap(lbox)
            small = strip.resize((max(1, strip.width // 4), max(1, strip.height // 4)),
                                 Image.NEAREST)
            hh = hashlib.md5(small.tobytes()).hexdigest()
            changed = hh != last_list_hash
            last_list_hash = hh

            # 红点检测每轮都做，**不再只在列表条带变化时才做**。
            # 踩过的坑：同一个人连发两句一模一样的话（「你好」「你好」），
            # 会话行的预览文字、行位置、右侧时间全都没变 -> 条带哈希恒定
            # -> 旧逻辑直接 continue，第二条连检测都没触发，用户干等到怀疑人生。
            # 红点才是「有新消息」的权威信号，这步缩小 3 倍再扫只要 8ms，
            # 而且截图本来就是每轮都抓的，等于白送。
            unread = find_unread_rows(strip, win, origin=(lbox[0], lbox[1]))
            if not unread:
                wait = cfg['pollInterval'] if not changed else 0.15
                continue
            log('unread rows at y=%s (strip %s)' % (unread, 'changed' if changed else 'same'))
            wait = 0.15                          # 可能连着来消息，处理完立刻再看
            # 3. 逐个处理。回复模式最多 2 个防失控；监听模式要「处理所有信息」，
            # 放宽到 6 个——多人同时来消息时红点会并存，只取前 2 个会漏收。
            # 监听不调模型不发送，单个会话的开销就是几次 OCR，扛得住。
            max_unread = 6 if cfg.get('observeOnly') else 2
            # 打不开的行要冷却：微信偶尔会把聊天区点成空白（点已有的选中行、
            # 或者切会话时窗口没焦点），这时红点还在、又打不开，不冷却就会
            # 「每 0.15 秒重试一次」把 CPU 打满（实测 96%，日志刷几千行）。
            fails = st.setdefault('openFail', {})
            nowts = time.time()
            for k in [k for k, v in fails.items() if v < nowts]:
                del fails[k]            # 过期的清掉，别让 state 无限涨
            for uy in unread[:max_unread]:
                if fails.get(str(uy), 0) > nowts:
                    continue
                t_start = time.time()
                shot2, bands = open_chat(win, uy, strip=strip,
                                         origin=(lbox[0], lbox[1]))
                if not shot2:
                    # 90 秒后再试：够微信把聊天区恢复出来，也不至于漏掉这条消息
                    # （红点在冷却期间一直挂着，到点会重新触发）。
                    fails[str(uy)] = time.time() + 90
                    save_state(st)
                    log('open failed at y=%d, cooldown 90s, skip' % uy)
                    continue
                # 只收不发：读完标题就逐条归档 + 留截图，后面的模型/发送整段跳过。
                # 不能用 bands[-1]['kind'] != 'in' 提前 continue——监听模式要记录
                # **所有**对方消息，最后一条是我方消息不代表前面没有新消息。
                if cfg.get('observeOnly'):
                    title = get_chat_title(shot2, win)
                    if title:
                        observe_chat(shot2, win, bands, title, st)
                    else:
                        log('observe: title empty at y=%d, skip' % uy)
                    continue
                if bands[-1]['kind'] != 'in':
                    log('last msg is ours, skip')
                    continue
                t0 = time.time()

                # 正文先读：它同时是判重 key 和 LLM 的输入。
                #
                # **不要并行跑标题和正文两次 OCR。** 试过了：两个 ctypes 实例
                # 看似各占一核，实测 579ms（串行才 295ms），更糟的是正文直接认错
                # （「我想你了」变成「J FAS」）——tesseract 实例之间有共享的全局状态，
                # 同时 SetImage/GetUTF8Text 会互相踩。串行是唯一安全的写法。
                #
                # 读的是「最后连续几条对方消息」而不是只读最后一条：对方连发
                # 「发个语音」「快点」「发个照片」时，只给最后一句等于断章取义。
                incoming = read_incoming(shot2, win, bands)
                if not incoming:
                    log('ocr empty, skip')
                    continue

                # 标题必须在调 LLM **之前**读：上下文是按会话名存的。旧版为了
                # 抢那 100ms 先把请求发出去、标题后读，代价是 session 只能传空串，
                # 于是 history 永远是空——模型零上下文，这才是「没看懂」的第二大原因。
                # 现在 OCR 已经压到 40~80ms，这 100ms 让得起。
                title = get_chat_title(shot2, win)
                if not title:
                    log('title empty at y=%d, skip' % uy)
                    continue
                skip = should_skip_session(title, cfg)
                if skip:
                    log('"%s" skipped (%s)' % (title, skip))
                    continue
                if not in_whitelist(title, cfg['whitelist']):
                    log('"%s" not in whitelist, skip' % title)
                    continue
                # 归档放在守卫之前：冷却/限流只是「现在不回」，消息本身该记住。
                # 只在要回之前才记，等于把库剪成「我回过的话」，以后问「他之前
                # 说过什么」就答不上来（QQ 那边也是同一个原则）。重复扫描由
                # arc_incoming 内部按判重窗口去重。
                arc_incoming(title, incoming)
                guard = check_guard(cfg, st, title)
                if guard == 'cooldown':
                    # 冷却期内又来消息时**不能直接跳过**：红点在 open_chat 那一步
                    # 已经被点掉了，这条消息下次也不会再被扫到——跳过一次，
                    # 对方就永远等不到回复（和判重吞消息是同一类坑）。
                    # 此时会话还开着、气泡还在，最省事的正确做法是原地等冷却走完。
                    left = cfg['sessionCooldown'] - (time.time() - st.get('lastReply', {}).get(title, 0))
                    if left > 0:
                        log('cooldown %s, 等 %.1fs 再回' % (title, left))
                        time.sleep(left + 0.2)
                    guard = check_guard(cfg, st, title)
                if guard:
                    log('guard %s for %s, skip' % (guard, title))
                    continue
                log('title=%s incoming=%s (ocr %.0fms)'
                    % (title, incoming.replace('\n', ' / '), (time.time() - t0) * 1000))
                # 判重不能只看文本。旧版 key 就是 md5(标题+正文)，后果是
                # 「你好」「你好」第二条永远被当成重复吞掉——而且 continue 是静默的，
                # 日志里只留一句 incoming=你好 就没了，查了半天以为是链路卡死。
                # 现在把气泡数算进去：真来了个新气泡，数量就会变。
                key = hashlib.md5(('%s|%s|%d' % (title, incoming, len(bands))).encode()).hexdigest()
                prev = st.get('seenDigest', {}).get(title)
                since = time.time() - st.get('lastReply', {}).get(title, 0)
                # 但气泡数也会因为滚动、「对方正在输入」抖动，所以再补一道时间闸：
                # 只有「刚刚才为同样内容回过」才认定是重复扫描（红点没消掉那种）。
                # 隔了十分钟又来同样一句，那是人家真的又问了一次，必须回。
                if prev == key and since < DUP_WINDOW:
                    log('dup of last reply (%.0fs ago, %d bubbles), skip' % (since, len(bands)))
                    continue
                # 到这一步才确定要回，才去调模型：白名单/冷却/判重全部前置，
                # 省下的是 token 和限流额度（之前连续测十几次直接吃到 429）。
                hist = hist_text(title, excl=incoming)
                # 上下文条数写进日志：改成读归档以后，「模型是不是真拿到上文」
                # 只能靠这个数说话——0 就说明归档没写进去或会话名对不上。
                nctx = hist.count('\n') + 1 if hist else 0
                t_sub = time.time()
                fut = _LLM_EXEC.submit(llm_reply, cfg, title, incoming, hist)
                t1 = time.time()
                res = fut.result()
                llm_ms = (time.time() - t_sub) * 1000
                if not res:
                    continue
                reply, pic = res
                log('reply to %s: %s%s (ctx %d条, llm %.0fms, 实际等 %.0fms)'
                    % (title, reply[:60], ('  [配图 %s]' % os.path.basename(pic)) if pic else '',
                       nctx, llm_ms, (time.time() - t1) * 1000))
                t2 = time.time()
                time.sleep(random.uniform(cfg['replyMinDelay'], cfg['replyMaxDelay']))
                # 真人是一句一条地发。多数回复本来就一句话，这里就是发一条；
                # 模型偶尔给两句时拆开，比整段发自然得多。
                parts = _split_msg(reply) if reply else []
                sent = 0
                for pi, part in enumerate(parts):
                    if pi:
                        # 条间隔按字数估打字时间（len/7 秒），send_reply 内部
                        # 已经等了 0.45s，这里只补差额
                        time.sleep(max(0.15, len(part) / 7.0 - 0.45))
                    if not send_reply(part, win):
                        break
                    sent += 1
                # 图和话分两条发：塞进同一条里微信会渲染成图文混排，一眼机器人。
                # 隔 0.9~1.3s 像是说完话才想起来配张图。
                if pic:
                    if sent:
                        time.sleep(random.uniform(0.9, 1.3))
                    if not send_image(pic, win):
                        log('配图失败 %s' % os.path.basename(pic))
                if not sent and not pic:
                    log('send failed, skip state update')
                    continue
                if len(parts) > 1:
                    log('拆成 %d 条发送（成功 %d）' % (len(parts), sent))
                # 收到的那条在守卫之前已经进归档了，这里只补「我发出去的」，
                # 而且必须是真发出去了才记——失败的一轮不该污染下一轮的上下文。
                if reply:
                    arc_append(title, reply, me=True)
                if pic:
                    arc_append(title, '', me=True, kind='image')
                st.setdefault('lastReply', {})[title] = time.time()
                st.setdefault('seenDigest', {})[title] = key
                st['hourCount'] = st.get('hourCount', 0) + 1
                save_state(st)
                # 端到端拆账：打开+OCR / LLM / 拟人延迟+发送
                log('done %s in %.1fs (open+ocr %.1fs, llm %.1fs, delay+send %.1fs)' % (
                    title, time.time() - t_start, t_sub - t_start, llm_ms / 1000,
                    time.time() - t2))

        except Exception as e:
            log('loop err: %s' % e)
            time.sleep(5)

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'probe':
        # 校准模式：输出窗口几何 + 各区域 OCR 结果
        win = win_geometry()
        log('win=%s' % (win,))
        if win:
            shot = screenshot()
            log('title=[%s]' % get_chat_title(shot, win))
            bands = scan_bubbles(shot, win)
            log('bands=%s' % bands)
            for b in bands:
                log('%s|%s' % (b['kind'], ocr_band(shot, win, b)))
            uy = find_unread_rows(shot, win)
            log('unread=%s' % uy)
    elif len(sys.argv) > 1 and sys.argv[1] == 'once':
        # 单次模式：处理当前打开的会话（不看红点、不看白名单），用于联调
        cfg = load_cfg()
        win = win_geometry()
        log('win=%s' % (win,))
        shot = screenshot()
        title = get_chat_title(shot, win)
        log('title=%s' % title)
        bands = scan_bubbles(shot, win)
        log('bands=%s' % bands)
        if not bands:
            log('没有气泡')
        elif bands[-1]['kind'] != 'in':
            log('最后一条是我方消息，无需回复')
        else:
            incoming = ocr_band(shot, win, bands[-1])
            log('incoming=%s' % incoming)
            res = llm_reply(cfg, title, incoming) if incoming else None
            log('llm reply=%s' % (res,))
    elif len(sys.argv) > 1 and sys.argv[1] == 'img':
        # 发一张图到当前会话（联调用）：python3 wx_agent.py img /data/media/pics/x.gif
        win = win_geometry()
        log('win=%s' % (win,))
        ok = send_image(sys.argv[2], win)
        log('send image ok=%s' % ok)
    elif len(sys.argv) > 1 and sys.argv[1] == 'voice':
        # 合成一句话并当语音发出去（联调用）：python3 wx_agent.py voice 晚安
        cfg = load_cfg()
        win = win_geometry()
        log('win=%s' % (win,))
        wav = tts_wav(sys.argv[2], cfg)
        log('tts -> %s' % wav)
        ok = send_voice(wav, win)
        log('send voice ok=%s' % ok)
    elif len(sys.argv) > 1 and sys.argv[1] == 'send':
        # 直接发一条消息到当前会话（联调用）
        cfg = load_cfg()
        win = win_geometry()
        log('win=%s' % (win,))
        ok = send_reply(sys.argv[2], win)
        log('send ok=%s' % ok)
    else:
        main_loop()
