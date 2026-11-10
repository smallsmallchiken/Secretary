#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""每日清单生成器（只收不发模式的配套产出）。

把当天 QQ 与微信的**全量**归档合并，做两件事：

  1. 用大模型提炼「需要我处理/回复的待办」：请求、约定、约时间、要文件、
     要照片、@我、问了我还没答的话；
  2. 原样保留「全量流水」：按会话分组，所有消息都列，媒体带缩略图。

产出 Markdown + 自包含 HTML（媒体复制进 daily/<日期>/media/，整目录拷回
本地就能离线翻看），失败降级：模型挂了也要给出纯流水清单，不能没报告。

设计约束：
  - 服务器是 CentOS 7 / Python 3.6，**只用标准库**（没有 requests）。
  - 模型锁死 deepseek-ai/DeepSeek-V4.1-Flash（项目约定），enable_thinking=False。
  - 不发送任何消息，只读归档 + 调模型。

用法：
  python3 daily_report.py                 # 今天（北京时间）
  python3 daily_report.py --date 2026-11-06
  python3 daily_report.py --date ... --out /path/to/daily
"""

import argparse
import base64
import difflib
import html
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request

TZ_OFF = 8 * 3600

# 默认路径全部指向服务器上的实际布局，可用环境变量覆盖（本地自测方便）
ROOT = os.environ.get('DAILY_ROOT', '/opt/secretary/.data')
QQ_ARCHIVE = os.environ.get('DAILY_QQ_ARCHIVE', os.path.join(ROOT, 'archive'))
WX_ARCHIVE = os.environ.get('DAILY_WX_ARCHIVE', os.path.join(ROOT, 'archive', 'wechat'))
QQ_INBOX = os.environ.get('DAILY_QQ_INBOX', os.path.join(ROOT, 'inbox'))
WX_INBOX = os.environ.get('DAILY_WX_INBOX', '/opt/linux-im/inbox')
CONFIG = os.environ.get('DAILY_CONFIG', os.path.join(ROOT, 'config.json'))
PROFILE = os.environ.get('DAILY_PROFILE', os.path.join(ROOT, 'profile.json'))
OUT_DIR = os.environ.get('DAILY_OUT', os.path.join(ROOT, 'daily'))

MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash'
VISION_MODEL = 'Qwen/Qwen3-VL-32B-Instruct'
ASR_MODEL = 'FunAudioLLM/SenseVoiceSmall'
MAX_MODEL_CHARS = 14000          # 喂给模型的流水上限，防超长

KIND_LABEL = {
    'text': '文字', 'image': '图片', 'sticker': '表情包', 'mface': '表情包',
    'face': '表情', 'bface': '表情', 'sface': '表情', 'record': '语音',
    'voice': '语音条', 'video': '视频', 'file': '文件', 'media': '媒体',
    'json': '卡片', 'xml': '卡片', 'share': '分享', 'location': '位置',
    'contact': '名片', 'music': '音乐', 'poke': '戳一戳'
}


def bj_day(ts=None):
    # time.gmtime + 偏移：兼容服务器 Python 3.6，也不依赖本机时区
    return time.strftime('%Y-%m-%d', time.gmtime((ts or time.time()) + TZ_OFF))


def bj_time(ts):
    return time.strftime('%H:%M', time.gmtime(int(ts) + TZ_OFF))


def bj_stamp():
    return time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(time.time() + TZ_OFF))


def log(msg):
    sys.stdout.write('[daily] %s\n' % msg)
    sys.stdout.flush()


def read_jsonl(path):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                pass  # 半行跳过，进程被杀时常见
    return rows


def load_config():
    try:
        d = json.load(open(CONFIG, 'r', encoding='utf-8'))
    except Exception as e:
        log('配置读取失败: %s' % e)
        return {}
    return d


def load_messages(day):
    """合并 QQ + 微信当天归档，按时间升序。统一成内部字典。"""
    out = []
    qq_path = os.path.join(QQ_ARCHIVE, day + '.jsonl')
    for r in read_jsonl(qq_path):
        out.append(normalize(r, 'QQ'))
    # 微信归档：同步后的 wechat/wx-YYYY-MM-DD.jsonl 优先，容器原始目录兜底
    # **容器原件优先**：`wechat/` 那份是宿主机每分钟按字节偏移同步的副本，
    # 可能是旧版本（比如正文刚被视觉模型修补过），先读它会让修补失效、
    # 同一条消息按旧正文出现。原件永远是最新的，副本只补它还没同步到的那几条。
    wx_paths = [
        '/opt/linux-im/archive/wx-' + day + '.jsonl',
        os.path.join(WX_ARCHIVE, 'wx-' + day + '.jsonl')
    ]
    seen = set()
    for p in wx_paths:
        if not os.path.exists(p):
            continue
        for r in read_jsonl(p):
            # 去重键用「时间 + 会话 + 指纹」：**不能带正文**。
            # 同步副本可能比原件旧一分钟，而正文会被后续修补（比如把
            # `[文件]` 换成视觉模型读出的文字），一带正文就对不上，同一条
            # 消息会在流水里出现两遍（实测 50 条被算成 67 条）。
            key = (r.get('t'), r.get('id'), r.get('mid'))
            if not r.get('mid'):
                key = (r.get('t'), r.get('id'), r.get('x'), r.get('k'))
            if key in seen:
                continue
            seen.add(key)
            out.append(normalize(r, '微信'))
        # 两个来源都读：wechat/ 是宿主机每分钟同步的副本（可能滞后一分钟），
        # /opt/linux-im/archive 是容器直接写的原件。取并集去重才不会漏掉
        # 刚生成清单前几秒进来的最后一条消息。
    out.sort(key=lambda m: m['t'])
    # 只收私聊：群消息一律不进清单（采集侧已经不再入档，挡的是历史存量）。
    before = len(out)
    out = [m for m in out if not is_group_msg(m)]
    if len(out) != before:
        log('%s: 跳过 %d 条群聊消息（只收私聊）' % (day, before - len(out)))
    # 序号给模型引用媒体用
    for i, m in enumerate(out):
        m['no'] = 'n%d' % (i + 1)
    return out


def normalize(r, platform):
    # 两侧归档的 src 写法不统一（qq / QQ / wx / 微信），统一成展示名
    raw = str(r.get('src') or platform)
    plat = 'QQ' if raw.lower() in ('qq', 'q') else '微信'
    kinds = str(r.get('k') or 'text')
    medias = r.get('m') or []
    labels = []
    for mm in medias:
        t = mm.get('t')
        if t and t != 'text':
            labels.append(KIND_LABEL.get(t, t))
    if not labels and kinds != 'text':
        labels = [KIND_LABEL.get(k, k) for k in kinds.split('+') if k and k != 'text']
    return {
        't': int(r.get('t') or 0),
        'platform': plat,
        'who': ('我' if r.get('me') else (r.get('sn') or r.get('n') or '对方')),
        # 原样留一份发送者昵称：微信群消息才有这个字段，`is_group_msg` 靠它认群
        'sn': str(r.get('sn') or ''),
        'chat': r.get('n') or r.get('id') or '?',
        'chat_type': '群聊' if r.get('c') == 'group' else '',
        'text': clean_text(r.get('x') or ''),
        'kinds': kinds,
        'labels': labels,
        'medias': medias,
        'shot': r.get('shot') or '',
        'mid': r.get('mid') or '',
        'me': bool(r.get('me')),
        'no': ''
    }


_UI_TAIL_RE = re.compile(r'(?:\.{2,}|…)?\s*(?:More|链接文本|查看更多|查看详情|地址定位信息)\s*$')
_REF_TAIL_RE = re.compile(r'[（(]\s*n\d+\s*[)）]')
_NOISE_HEAD_RE = re.compile(r'^(?:[A-Z]{1,6}[\s.]+)+(?=[\u4e00-\u9fa5【\[（(])')


def clean_text(t):
    """正文清洗：OCR 噪声、UI 尾巴、模型引用序号。

    监听模式读的是屏幕，脏东西有固定几种形态，都能用规则剥掉：
      - 开头一串大写拉丁字母（`ROSAS ACT LB A 【时间】…` 头几名是头像/时间戳残影）；
      - 尾部 `More` / `链接文本` / `地址定位信息`（右键菜单与定位卡片残留）；
      - `（n15）` 这种给模型看的引用序号，绝不能漏到给人看的清单里。
    """
    t = str(t or '').replace('\u200b', '').strip()
    t = _REF_TAIL_RE.sub('', t)
    for _ in range(3):
        n = _UI_TAIL_RE.sub('', t).strip()
        if n == t:
            break
        t = n
    t = _NOISE_HEAD_RE.sub('', t)
    return re.sub(r'[ \t]+', ' ', t).strip()


def _cmp_key(t):
    """比较两个人名/会话名/正文用的归一键：去标点空格，小写。"""
    return re.sub(r'[^\u4e00-\u9fa5A-Za-z0-9]', '', str(t or '')).lower()


def _chat_size(name):
    m = re.search(r'[（(](\d{1,4})[)）]', name or '')
    return m.group(1) if m else ''


# 群名特征。**只收私聊**之后，历史归档里的群消息还要在生成清单时挡掉：
# 之前攒下来的群消息不会自己消失，不挡的话清单里仍然是一堆群聊。
# 判据要稳，别把私聊名字里带「群」的联系人（「家教群主」）也误杀：
#   - 人数后缀 `(237)`：微信群的标题固定这么写，私聊几乎没有；
#   - 明确的群词：群聊/聊天群/交流群/家教群/兼职群/工作群/Group/Chatroom。
_GROUP_NAME_RE = re.compile(
    r'[（(]\s*\d{1,4}\s*[)）]|群聊|聊天群|交流群|家教群|兼职群|工作群|Group\b|Chatroom',
    re.I)


def is_group_msg(m):
    """一条归一化后的消息是不是群聊来的。

    QQ 归档有 `c=group`；微信归档没有这个字段，靠三样东西认：
      - `sn`（发送者昵称）：微信群消息才有，私聊永远是空；
      - 会话名里的人数后缀或群词；
      - `chat_type`（normalize 时从 c 带过来的）。
    """
    if m.get('chat_type'):
        return True
    if m.get('platform') == '微信' and str(m.get('sn') or '').strip():
        return True
    return bool(_GROUP_NAME_RE.search(str(m.get('chat') or '')))


def merge_chat_names(msgs):
    """把 OCR 读歪的会话名挂回同一个名字。

    标题每轮都重新 OCR：`乌鲁木齐欣欣向荣大学生群四(237)` 会读成 `…群办(237)`，
    `QSp乌鲁木齐01家教老师群(382)` 又会读成 `Q&P乌针木齐01家教老师群(382)`。
    归档按会话名分组，名字一变就多出一个假会话——一份清单里十四个会话，五个是
    同一批群的变体，看着像进了十几个群。

    合并条件（宁可不合，不可乱合）：
      - 平台相同；
      - 两边人数后缀都有时必须相同（`(237)` ≠ `(382)`，那是两个群）；
      - 归一后名字长度 ≥6 且相似度 ≥0.72；短名（G / ER / DHX）只认完全相同。
    合并后统一用簇里**出现次数最多、其次最长**的那个名字（OCR 常漏字，长的更全）。
    """
    freq = {}
    first = {}
    for m in msgs:
        k = (m['platform'], m['chat'])
        freq[k] = freq.get(k, 0) + 1
        if k not in first or m['t'] < first[k]:
            first[k] = m['t']
    clusters = []               # [{'names': set, 'key': str, 'size': str, 'plat': str}]
    for (plat, name), _c in sorted(freq.items(), key=lambda kv: (-kv[1], first[kv[0]])):
        key = _cmp_key(name)
        size = _chat_size(name)
        hit = None
        if len(key) >= 6:
            best, best_r = None, 0.0
            for cl in clusters:
                if cl['plat'] != plat:
                    continue
                # **必须至少一边带人数后缀**：`…群四(237)` / `…群办(237)` 是同一个群，
                # 但「P*上门家教…胡老师」和「A*卜家教…许老师」这种人名相似度也有 0.8，
                # 不带后缀一律不合并，宁可留两个真联系人，也不能把两个人并成一个。
                if not (size or cl['size']):
                    continue
                if size and cl['size'] and size != cl['size']:
                    continue
                r = difflib.SequenceMatcher(None, key, cl['key']).ratio()
                if r > best_r:
                    best, best_r = cl, r
            if best is not None and best_r >= 0.72:
                hit = best
        if hit is None:
            clusters.append({'names': {name}, 'key': key, 'size': size, 'plat': plat})
        else:
            hit['names'].add(name)
            if len(key) > len(hit['key']):
                hit['key'] = key
                hit['size'] = hit['size'] or size
    canon = {}
    for cl in clusters:
        # 主名：出现最多 → 最早出现 → 最长。平票时用「最早读到的那次」，
        # 后续重读更容易被 OCR 读歪（实测「…群四(237)」第二轮变成「…群办(237)」）。
        head = min(cl['names'], key=lambda n: (-freq[(cl['plat'], n)],
                                               first[(cl['plat'], n)], -len(n)))
        for n in cl['names']:
            canon[(cl['plat'], n)] = head
    changed = 0
    for m in msgs:
        c = canon.get((m['platform'], m['chat']))
        if c and c != m['chat']:
            m['chat_raw'] = m['chat']
            m['chat'] = c
            changed += 1
    return changed, len(clusters)


def dedup_near(msgs, window=3600, thr=0.92, look=8):
    """同一会话里几乎一样的连发只留一条（转发同一段家教信息、OCR 重读一遍）。

    微信监听对着同一屏抓好几轮，同一条长文案被读到两次很常见，流水里就出现
    两行 95% 相同的字。这里按「平台+会话+发送者」在 1 小时内比相似度：

      - 相似度 ≥0.92，或一方包含另一方 → 同一条，合并；
      - 前 12 个字（归一后）完全一样且相似度 ≥0.85 → 也是同一条。家教信息都带
        同一串编号（`WLMQ26111056`、`乌鲁木齐26111032`），OCR 抄歪中间几个字
        会让整体相似度掉到 0.91，但编号一样就肯定是同一张单子。

    合并时保留**更完整**的那版正文，只记一个 `dup` 次数，渲染成「×2（重发）」。
    阈值故意偏高：家教群里不同学员的信息结构雷同，放低会把真消息吃掉。
    """
    out = []
    keep_at = {}
    for m in msgs:
        if len(m['text']) < 10:
            out.append(m)
            continue
        k = (m['platform'], m['chat'], m['who'])
        a = _cmp_key(m['text'])
        sig = a[:12]
        dropped = None
        for prev in keep_at.get(k, []):
            if m['t'] - prev['t'] > window:
                continue
            b = _cmp_key(prev['text'])
            r = difflib.SequenceMatcher(None, a, b).ratio() if b else 0.0
            if (r >= thr or (len(b) >= 10 and (a in b or b in a))
                    or (sig == b[:12] and r >= 0.85)):
                dropped = prev
                break
        if dropped is not None:
            dropped['dup'] = dropped.get('dup', 1) + 1
            if len(a) > len(_cmp_key(dropped['text'])):
                dropped['text'] = m['text']        # 留更完整的那版
            continue
        out.append(m)
        keep_at.setdefault(k, []).append(m)
        if len(keep_at[k]) > look:
            del keep_at[k][0]
    return out


def load_media_index(day):
    """合并两侧媒体索引，按 (平台, mid, 序号) 挂到消息上。"""
    index = {}
    files = [
        (QQ_INBOX, 'qq', 'QQ'),
        (WX_INBOX, 'wx', '微信')
    ]
    for base, sub, plat in files:
        p = os.path.join(base, day, sub, 'media-index.jsonl')
        for r in read_jsonl(p):
            k = (plat, str(r.get('mid') or ''), int(r.get('i') or 0))
            index.setdefault(k, []).append(r)
    return index


def load_lib_desc():
    """读素材库已经理解好的文字，按消息指纹 mid 索引。

    只存文字之后，原件（图片/语音/文件/截图）在理解完就被删了，清单不能再
    靠文件路径去找内容，必须直接复用 media_lib.py 的成果。这样也避免了
    清单和素材库各调一次模型、两份描述说法不一样。
    """
    out = {}
    p = os.path.join(ROOT, 'media', 'received', 'library.jsonl')
    for r in read_jsonl(p):
        mid = str(r.get('mid') or '')
        if not mid or mid in out:
            continue
        txt = (r.get('desc') or r.get('text') or '').strip()
        if txt:
            out[mid] = re.sub(r'\s+', ' ', txt)[:300]
    return out


def attach_media(msgs, index, lib=None):
    """给每条消息挂上「这条媒体是什么」的文字说明。

    不再复制任何文件：素材库理解完就删原件，清单目录里也不留二进制。
    """
    lib = lib or {}
    by_mid = {}
    for (p, mid, i), rr in index.items():
        by_mid.setdefault((p, str(mid)), []).extend(rr)
    gallery = []
    for m in msgs:
        plat = 'QQ' if m['platform'] in ('QQ', 'qq') else '微信'
        m['files'] = []
        rows = []
        if m['shot']:
            # 只看归档字段会挂一堆空壳：微信截图的原件被素材库理解完就删了
            # （用户要求只存文字、省内存），`shot` 里留的是悬空路径，清单里
            # 就出现「截图（素材库还没理解出来）」这种什么都没说明的行。
            if os.path.exists(os.path.join(WX_INBOX, m['shot'])):
                rows.append({'type': '', 'label': '截图'})
        for r in by_mid.get((plat, str(m['mid'])), []):
            rows.append({'type': r.get('type') or '',
                         'label': KIND_LABEL.get(r.get('type'), r.get('type') or '媒体')})
        for r in rows:
            desc = lib.get(str(m['mid']), '')
            item = {'label': r['label'], 'desc': desc, 'chat': m['chat'],
                    'time': bj_time(m['t']), 'platform': plat, 'no': m['no'],
                    'size': 0}
            m['files'].append(item)
            gallery.append(item)
    return gallery



def enrich_media(msgs, gallery, cfg=None, out_day=None):
    """把素材库理解好的描述回填到消息正文。

    以前这里会再调一次视觉/ASR：同一张图清单理解一遍、素材库又理解一遍，
    钱翻倍，两处说法还可能不一样。现在统一以素材库为准，这里只做回填。
    """
    n = 0
    by_no = {}
    for m in msgs:
        by_no.setdefault(m['no'], m)
    for f in gallery:
        desc = (f.get('desc') or '').strip()
        if not desc:
            continue
        m = by_no.get(f['no'])
        if not m:
            continue
        if not m['text']:
            m['text'] = desc
        elif m['text'].startswith('['):
            # 保留类型标记：'[图片] 一只橘猫趴在键盘上'
            m['text'] = '%s %s' % (m['text'], desc)
        else:
            m['text'] += '（%s）' % desc
        n += 1
    return n


def build_flow_text(msgs):
    """给模型看的紧凑流水。媒体只写类型标签，不塞原文件内容。"""
    lines = []
    for m in msgs:
        tags = ('[' + '/'.join(m['labels']) + ']') if m['labels'] else ''
        who = m['who'] + ('（我）' if m['me'] else '')
        body = m['text'].replace('\n', ' ').strip() or tags or '（空）'
        lines.append('%s %s %s %s %s: %s' % (
            m['no'], bj_time(m['t']), m['platform'],
            (m['chat'] + ('·群' if m['chat_type'] else '')), who, body[:300]))
    text = '\n'.join(lines)
    if len(text) > MAX_MODEL_CHARS:
        text = text[:MAX_MODEL_CHARS] + '\n…（流水过长已截断，完整清单见下方）'
    return text


TODO_PROMPT = '''你是私人秘书，负责把主人当天的 QQ/微信消息整理成「每日待办清单」。

只挑**别人对主人提出、需要主人后续处理或回应**的事，包括：
- 明确的请求、拜托、要求（帮我…／麻烦…／能不能…／把…发我／帮我改…）
- 约定、约时间、日程、要交的东西、有截止时间的安排
- 点名要文件、照片、资料、链接，或问「…有信了没／好了没」这类催办
- @主人、直接提问而主人当天没回答的话
- 对方发来的文件/图片/语音里明显需要主人处理的（todo 里用 ref 指回那条消息）

不要收进待办：纯闲聊、寒暄、表情包、广告、系统通知、主人自己说的话、
已经明确答复完的事、群里的灌水。宁可少列也不要硬凑。

严格输出 JSON（不要 markdown 代码块、不要解释）：
{"todos":[{"who":"谁提的","platform":"QQ或微信","time":"HH:MM","item":"一句话说清要做什么","quote":"最关键的原文，20字内","priority":"high或normal","ref":"对应流水开头的 n序号"}],"summary":"两三句话概括今天"}

没有待办就输出 {"todos":[],"summary":"…"}。'''


def profile_block():
    """主人的背景，用来判断「哪些事跟我有关」。

    读的是**精简版** profile.json（姓名/学校/专业/方向），不含身份证与手机号：
    完整档案留在本机 .data/profile.md，服务器只放这份必要信息。
    文件不存在就返回空串，提示词退回原样——不能因为缺档案就不出清单。
    """
    try:
        with open(PROFILE) as f:
            p = json.load(f)
    except Exception:
        return ''
    if not isinstance(p, dict):
        return ''
    bits = []
    for key, label in (('name', '姓名'), ('school', '学校'), ('major', '专业'),
                       ('stage', '当前阶段'), ('direction', '研究方向'),
                       ('skills', '技能'), ('focus', '关注事项')):
        v = p.get(key)
        if isinstance(v, list):
            v = '、'.join([str(x) for x in v if x])
        if v:
            bits.append('%s：%s' % (label, v))
    if not bits:
        return ''
    return ('\n\n【主人是谁】\n' + '\n'.join('- ' + b for b in bits) +
            '\n判断时结合这些背景：与主人学业/科研/求职强相关的事优先；'
            '广告、刷单、兼职、贷款、陌生推销一律不收进待办。')


def call_llm(cfg, flow):
    llm = cfg.get('llm') or {}
    key = llm.get('apiKey') or ''
    base = (llm.get('baseUrl') or 'https://api.siliconflow.cn/v1').rstrip('/')
    if not key:
        return None, '未配置 apiKey'
    body = {
        'model': MODEL,
        'messages': [
            {'role': 'system', 'content': TODO_PROMPT + profile_block()},
            {'role': 'user', 'content': '这是今天的全部消息流水：\n\n' + flow}
        ],
        'max_tokens': 1400,
        'temperature': 0.3,
        'enable_thinking': False,
        'stream': False
    }
    req = urllib.request.Request(
        base + '/chat/completions',
        data=json.dumps(body).encode('utf-8'),
        headers={'Content-Type': 'application/json',
                 'Authorization': 'Bearer ' + key})
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            d = json.loads(res.read().decode('utf-8'))
        raw = d['choices'][0]['message']['content'].strip()
    except Exception as e:
        return None, str(e)
    raw = re.sub(r'^```(?:json)?\s*|\s*```$', '', raw).strip()
    try:
        return json.loads(raw), ''
    except Exception:
        mt = re.search(r'\{[\s\S]*\}', raw)
        if mt:
            try:
                return json.loads(mt.group(0)), ''
            except Exception:
                pass
    return None, '模型输出不是合法 JSON: ' + raw[:120]


def fallback_todos(msgs):
    """模型不可用时的规则兜底：请求词 / 疑问句 / 约定词。

    宁可多列也别漏——这是给人自己勾的清单，不是自动执行。
    不要用「后面有我的发言就跳过」这种判断：监听模式下我方消息多来自
    多端同步，跟「这件事办没办」没关系，一刀切会把真待办全杀掉。
    """
    pat = re.compile(r'(帮|麻烦|能不能|可不可以|要不要|行不行|好不好|有空|一起|'
                     r'把.+发|给我|发我|记得|别忘|明天|后天|周[一二三四五六日末]|'
                     r'截止|之前|几点|约|有信了没|好了没|怎么样了|@|？|\?)')
    out = []
    for m in msgs:
        if m['me'] or not m['text']:
            continue
        if not pat.search(m['text']):
            continue
        out.append({'who': m['who'], 'platform': m['platform'],
                    'time': bj_time(m['t']), 'item': m['text'][:40],
                    'quote': m['text'][:20], 'priority': 'normal',
                    'ref': m['no']})
    return out[:20]


def group_by_chat(msgs):
    groups = []
    idx = {}
    for m in msgs:
        k = (m['platform'], m['chat'])
        if k not in idx:
            idx[k] = []
            groups.append((k, idx[k]))
        idx[k].append(m)
    return groups


def render_markdown(day, msgs, todos, summary, gallery, note):
    L = []
    L.append('# 每日待办清单 · %s' % day)
    L.append('')
    L.append('> 只收不发的监听记录｜共 %d 条消息、%d 个会话、%d 条媒体消息' % (
        len(msgs), len(group_by_chat(msgs)), len([m for m in msgs if m['labels']])))
    if note:
        L.append('> 模型提炼：%s（已用规则兜底）' % note)
    L.append('')
    L.append('## 一、需要我处理的待办')
    L.append('')
    if not todos:
        L.append('今天没有识别到需要后续处理的事项。')
    else:
        for i, t in enumerate(todos, 1):
            pri = ' **[急]**' if t.get('priority') == 'high' else ''
            L.append('- [ ] **%s**%s ｜ %s · %s · %s' % (
                t.get('item', ''), pri, t.get('platform', ''),
                t.get('who', ''), t.get('time', '')))
            q = _REF_TAIL_RE.sub('', t.get('quote') or '').strip()
            if q:
                L.append('      - 原话：%s' % q)
    L.append('')
    if summary:
        L.append('**今日概括**：%s' % summary)
        L.append('')
    L.append('## 二、全量流水')
    L.append('')
    for (plat, chat), rows in group_by_chat(msgs):
        is_group = any(r['chat_type'] for r in rows) or bool(_chat_size(chat)) or ('群' in chat)
        L.append('### %s · %s（%s%d 条）' % (
            plat, chat, '群聊 · ' if is_group else '', len(rows)))
        L.append('')
        for m in rows:
            tags = (' `' + '/'.join(m['labels']) + '`') if m['labels'] else ''
            body = m['text'].replace('\n', ' ') or '（无文字）'
            # 语音条/文件这类消息正文就是类型名，跟右边的标签重复，只留标签
            if m['labels'] and body.strip('[]（） ') in m['labels']:
                body = '（无文字）'
            who = m['who']
            if who == m['chat']:
                # 群昵称读不到时归档会沿用群名，私聊则是对方名字跟标题重名，
                # 两种情况在分组标题里已经写过一遍，正文里不必再重复。
                who = '群成员' if is_group else '对方'
            dup = ' ×%d（重发）' % m['dup'] if m.get('dup') else ''
            L.append('- `%s` **%s**：%s%s%s' % (bj_time(m['t']), who, body, tags, dup))
            for f in m.get('files') or []:
                # 正文里已经拼过描述（见 enrich_media），这里只在没理解到时
                # 补一个提示，同一句话不在一条消息里出现两遍。
                if not (f.get('desc') or '').strip():
                    L.append('  - %s（素材库还没理解出来）' % f['label'])
        L.append('')
    if gallery:
        L.append('## 三、媒体内容清单')
        L.append('')
        L.append('| 时间 | 平台 | 会话 | 类型 | 转写/描述 |')
        L.append('|---|---|---|---|---|')
        for f in gallery:
            L.append('| %s | %s | %s | %s | %s |' % (
                f['time'], f['platform'], f['chat'], f['label'],
                (f.get('desc') or '—').replace('|', '/')))
        L.append('')
    L.append('---')
    if any(m['platform'] == '微信' for m in msgs):
        L.append('> 注：微信消息的时间是「监听第一次看到它」的时间。监听是定时截屏的，'
                 '同一屏里一次抓下来的几条会显示同一个时刻（例如整批 13:34），'
                 '不代表真实发送顺序；QQ 的时间是服务端事件时间，是准的。')
        L.append('')
    L.append('生成时间：%s（北京时间）' % bj_stamp())
    return '\n'.join(L)


CSS = '''
:root{--bg:#f6f7f9;--card:#fff;--ink:#1c2128;--sub:#6b7480;--line:#e5e8ec;
--accent:#2f6feb;--warm:#c2410c;--ok:#0f766e}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1d222a;--ink:#e8ecf2;
--sub:#98a2b3;--line:#2c333d;--accent:#7aa2ff;--warm:#fb923c;--ok:#5eead4}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.7 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:27px;margin:0 0 6px}h2{font-size:19px;margin:38px 0 14px;
padding-bottom:8px;border-bottom:1px solid var(--line)}
h3{font-size:15px;margin:24px 0 10px;color:var(--sub);font-weight:600}
.meta{color:var(--sub);font-size:13px;margin-bottom:8px}
.note{background:color-mix(in srgb,var(--warm) 10%,transparent);border-left:3px solid var(--warm);
padding:8px 12px;font-size:13px;color:var(--sub);margin:12px 0;border-radius:4px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:14px 18px;margin-bottom:10px;display:flex;gap:12px;align-items:flex-start}
.card input{margin-top:6px;width:17px;height:17px;accent-color:var(--accent);flex:none}
.card .body{flex:1;min-width:0}.card.done{opacity:.5;text-decoration:line-through}
.item{font-weight:600}.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:20px;
background:var(--bg);color:var(--sub);border:1px solid var(--line);margin-right:6px}
.tag.hot{color:var(--warm);border-color:var(--warm)}
.quote{color:var(--sub);font-size:13px;margin-top:4px}
.summary{background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:14px 18px;color:var(--sub)}
.flow{background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:6px 18px 14px;margin-bottom:16px}
.row{display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--line);font-size:14px}
.row:last-child{border-bottom:0}.row .ts{color:var(--sub);font:12px/1.9 monospace;flex:none;width:42px}
.row .who{flex:none;width:88px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .txt{flex:1;word-break:break-word}
.kind{font-size:11px;color:var(--accent);border:1px solid var(--accent);
border-radius:4px;padding:0 5px;margin-left:6px;white-space:nowrap}
.thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.thumbs a{border:1px solid var(--line);border-radius:6px;overflow:hidden;display:block}
.thumbs img{max-width:150px;max-height:150px;display:block}
.thumbs .cap{font-size:11px;color:var(--sub);padding:3px 6px}
.empty{color:var(--sub);padding:12px 0}
table{width:100%;border-collapse:collapse;font-size:13px;background:var(--card)}
td,th{border:1px solid var(--line);padding:7px 10px;text-align:left}th{color:var(--sub)}
footer{color:var(--sub);font-size:12px;margin-top:40px;text-align:center}
'''


def render_html(day, msgs, todos, summary, gallery, note):
    E = html.escape
    P = []
    P.append('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">')
    P.append('<meta name="viewport" content="width=device-width,initial-scale=1">')
    P.append('<title>每日清单 %s</title><style>%s</style></head><body><div class="wrap">' % (day, CSS))
    P.append('<h1>每日待办清单 · %s</h1>' % day)
    P.append('<div class="meta">只收不发的监听记录｜%d 条消息 · %d 个会话 · %d 条媒体消息</div>' % (
        len(msgs), len(group_by_chat(msgs)), len([m for m in msgs if m['labels']])))
    if note:
        P.append('<div class="note">模型提炼未成功（%s），待办已用关键词规则兜底，流水完整。</div>' % E(note))
    P.append('<h2>一、需要我处理的待办</h2>')
    if not todos:
        P.append('<div class="empty">今天没有识别到需要后续处理的事项。</div>')
    for i, t in enumerate(todos):
        hot = ' hot' if t.get('priority') == 'high' else ''
        P.append('<label class="card" data-k="%s"><input type="checkbox" class="todo">' % E(t.get('ref', str(i))))
        P.append('<div class="body"><div class="item">%s</div>' % E(str(t.get('item', ''))))
        P.append('<div style="margin-top:5px"><span class="tag%s">%s</span>'
                 '<span class="tag">%s</span><span class="tag">%s · %s</span></div>' % (
                     hot, '急' if hot else '待办', E(str(t.get('platform', ''))),
                     E(str(t.get('who', ''))), E(str(t.get('time', '')))))
        if t.get('quote'):
            P.append('<div class="quote">原话：%s</div>' % (
                E(_REF_TAIL_RE.sub('', str(t['quote'])).strip())))
        P.append('</div></label>')
    if summary:
        P.append('<h2>今日概括</h2><div class="summary">%s</div>' % E(str(summary)))
    P.append('<h2>二、全量流水</h2>')
    for (plat, chat), rows in group_by_chat(msgs):
        is_group = any(r['chat_type'] for r in rows) or bool(_chat_size(chat)) or ('群' in chat)
        P.append('<h3>%s · %s（%s%d 条）</h3><div class="flow">' % (
            E(str(plat)), E(str(chat)), '群聊 · ' if is_group else '', len(rows)))
        for m in rows:
            tags = ''.join('<span class="kind">%s</span>' % E(x) for x in m['labels'])
            body = m['text'].replace('\n', ' ') or '（无文字）'
            if m['labels'] and body.strip('[]（） ') in m['labels']:
                body = '（无文字）'
            who = m['who']
            if who == m['chat']:
                # 群昵称读不到时归档会沿用群名，私聊则是对方名字跟标题重名，
                # 两种情况在分组标题里已经写过一遍，正文里不必再重复。
                who = '群成员' if is_group else '对方'
            dup = ('<span class="kind">×%d 重发</span>' % m['dup']) if m.get('dup') else ''
            P.append('<div class="row"><span class="ts">%s</span>'
                     '<span class="who">%s</span><span class="txt">%s%s%s</span></div>' % (
                         bj_time(m['t']), E(str(who)), E(body), tags, dup))
            imgs = [f for f in (m.get('files') or []) if not (f.get('desc') or '').strip()]
            if imgs:
                P.append('<div class="thumbs">')
                for f in imgs:
                    P.append('<div class="cap">%s（素材库还没理解出来）</div>' % E(f['label']))
                P.append('</div>')
        P.append('</div>')
    if gallery:
        P.append('<h2>三、媒体内容清单</h2><table><tr><th>时间</th><th>平台</th>'
                 '<th>会话</th><th>类型</th><th>转写/描述</th></tr>')
        for f in gallery:
            P.append('<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>' % (
                f['time'], E(f['platform']), E(str(f['chat'])), E(f['label']),
                E(str(f.get('desc') or '—'))))
        P.append('</table>')
    P.append('<footer>生成于 %s（北京时间）· 勾选状态保存在本浏览器</footer>' % bj_stamp())
    P.append('''<script>
(function(){var k='daily-'''+day+'''',s={};try{s=JSON.parse(localStorage.getItem(k)||'{}')}catch(e){}
var b=document.querySelectorAll('.todo');for(var i=0;i<b.length;i++){(function(el){
var id=el.parentNode.getAttribute('data-k');if(s[id]){el.checked=true;el.parentNode.classList.add('done')}
el.addEventListener('change',function(){s[id]=el.checked;el.parentNode.classList.toggle('done',el.checked);
localStorage.setItem(k,JSON.stringify(s))})})(b[i])}})();
</script></div></body></html>''')
    return '\n'.join(P)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date', default='')
    ap.add_argument('--yesterday', action='store_true',
                    help='补生成昨天：覆盖 23:30 之后到零点前漏掉的消息')
    ap.add_argument('--out', default=OUT_DIR)
    ap.add_argument('--no-llm', action='store_true')
    a = ap.parse_args()
    day = a.date or (bj_day(time.time() - 86400) if a.yesterday else bj_day())
    out_day = os.path.join(a.out, day)
    os.makedirs(out_day, exist_ok=True)

    msgs = load_messages(day)
    # 先把「整理」做完再交给下游：会话名归并 → 近似重发合并 → 重新编号。
    # 编号必须在这三步之后：编号是待办 ref 与媒体挂载的锚点，中间删过消息
    # 就会出现 n7/n9 跳号，模型引用的 ref 和流水对不上。
    n_merge, _cl = merge_chat_names(msgs)
    n_raw = len(msgs)
    msgs = dedup_near(msgs)
    for i, m in enumerate(msgs):
        m['no'] = 'n%d' % (i + 1)
    index = load_media_index(day)
    # 媒体的描述/转写/正文统一从素材库取（原件理解完就删了，清单里不留二进制）
    lib = load_lib_desc()
    gallery = attach_media(msgs, index, lib)
    media_msgs = len([m for m in msgs if m['labels']])
    log('%s: %d 条消息（合并重发 %d 条）, %d 个会话, %d 条媒体消息, %d 个已理解媒体' % (
        day, len(msgs), n_raw - len(msgs), len(group_by_chat(msgs)), media_msgs, len(gallery)))
    if n_merge:
        log('会话名归并：%d 条消息改挂到主名上' % n_merge)

    cfg = load_config()
    if gallery:
        n = enrich_media(msgs, gallery)
        log('媒体描述回填：%d 条（来自素材库）' % n)

    todos, summary, note = [], '', ''
    if msgs and not a.no_llm:
        data, err = call_llm(cfg, build_flow_text(msgs))
        if data:
            todos = data.get('todos') or []
            summary = data.get('summary') or ''
            log('模型提炼出 %d 条待办' % len(todos))
        else:
            note = err
            log('模型失败: %s' % err)
            todos = fallback_todos(msgs)
            summary = '模型不可用，待办由关键词规则提取，请以全量流水为准。'
    elif msgs:
        note = '手动跳过模型'
        todos = fallback_todos(msgs)
        summary = '待办由关键词规则提取。'
    else:
        summary = '今天没有收到任何消息。'

    md = render_markdown(day, msgs, todos, summary, gallery, note)
    htm = render_html(day, msgs, todos, summary, gallery, note)
    with open(os.path.join(out_day, 'daily.md'), 'w', encoding='utf-8') as f:
        f.write(md)
    with open(os.path.join(out_day, 'daily.html'), 'w', encoding='utf-8') as f:
        f.write(htm)
    # 稳定文件名，方便同步脚本和快捷入口
    with open(os.path.join(a.out, 'latest.md'), 'w', encoding='utf-8') as f:
        f.write(md)
    with open(os.path.join(a.out, 'latest.html'), 'w', encoding='utf-8') as f:
        f.write(htm)
    print('OK|%s|%d|%d|%s' % (day, len(msgs), len(todos), out_day))


if __name__ == '__main__':
    main()
