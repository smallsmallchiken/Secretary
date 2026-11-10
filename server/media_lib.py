#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""素材库：把 QQ/微信收到的图片、表情包、语音、视频、文件收进一个长期库，并读懂内容。

和 daily_report.py 的分工：
  daily_report.py  面向「某一天」，把当天消息整理成待办清单，媒体只做当天关联；
  media_lib.py     面向「长期」，按内容去重后归档成一个可检索的素材库，理解一次永久复用。

为什么要有它：
  inbox 里的文件是**按日期**铺开的，同一张表情包被转发十次就存十份，也不知道是什么内容；
  而「存表情包」真正的价值是以后能挑出来用、能按语义找回来。所以这里做四件事：
    1) 去重：按 sha1 归并，同一份内容只存一个文件，多个来源记在同一条目的 users 里；
    2) 分类：image / sticker / voice / video / file，表情包单独一类（QQ 图片段的
       sub_type、summary、emoji_id 是判据，光看 type=image 分不出来）；
    3) 理解：图片与表情包给视觉模型出「描述 + 标签」，语音走 ASR 转文字，
       文件抽取正文（docx/xlsx/pptx/zip/pdf/txt…），视频记元信息；
    4) 索引：library.jsonl 给程序读，素材库.md 给人读（带相对路径，整包拷走还能看）。

理解结果按 sha1 缓存（desc.json），重跑不重复烧钱；失败不写缓存，下一轮自己会补。

服务器只有 Python 3.6、没有 pdftotext / unzip / ffmpeg，所以文件解析全用标准库
（zipfile + zlib + 正则），PDF 只认能直接抽出来的文本，抽不到就老实标「需人工查看」。

用法：
  python3 media_lib.py                # 增量：收新素材 + 理解没理解过的
  python3 media_lib.py --limit 20     # 这次最多理解 20 个（控成本）
  python3 media_lib.py --no-llm       # 只入库和分类，不做模型理解（离线可用）
  python3 media_lib.py --rebuild      # 重建索引（raw 里的文件按 sha1 复用，不会重新下载）
"""

import base64
import hashlib
import html
import json
import os
import re
import shutil
import sys
import time
import urllib.request
import zipfile
import zlib

TZ_OFF = 8 * 3600

ROOT = os.environ.get('MEDIA_ROOT', '/opt/secretary/.data')
QQ_INBOX = os.environ.get('MEDIA_QQ_INBOX', os.path.join(ROOT, 'inbox'))
WX_INBOX = os.environ.get('MEDIA_WX_INBOX', '/opt/linux-im/inbox')
WX_ARCHIVE = os.environ.get('MEDIA_WX_ARCHIVE', '/opt/linux-im/archive')
# 注意：这里必须指**容器原件**（/opt/linux-im/archive），不是
# /opt/secretary/.data/archive/wechat。后者是宿主机 cron 每分钟按字节偏移
# 增量同步出来的副本，只读快照；往那儿写回填，下一分钟就被原件覆盖掉了。
CONFIG = os.environ.get('MEDIA_CONFIG', os.path.join(ROOT, 'config.json'))
# 收到的东西放 media/received/，和「发出去用的」表情包库 media/pics/ 平级分开：
# 两边用途不同（一个是被动存档+理解，一个是主动挑选发送），混在一个目录会互相干扰。
LIB = os.environ.get('MEDIA_LIB', os.path.join(ROOT, 'media', 'received'))

RAW = os.path.join(LIB, 'raw')
LIB_FILE = os.path.join(LIB, 'library.jsonl')
DESC_FILE = os.path.join(LIB, 'desc.json')
MD_FILE = os.path.join(LIB, '素材库.md')

# 每次运行最多理解多少个：视觉/语音都是按次计费，定时跑要有个闸
MAX_UNDERSTAND = 80
# 理解失败的素材多久之后才重试（秒）。cron 是每分钟一次，不退避会变成
# 「每分钟一次无效请求」。
FAIL_BACKOFF = 600
# 只存文字：理解完立刻删原件（图片/文件/语音/视频都不留）。理解失败的要
# 留着重试，但最多留这么久，超龄连原件一起删，只记一条「没理解成」的元信息。
# 不设上限的话，一个一直失败的坏文件会永久占着磁盘。
KEEP_SRC_DAYS = 3
# 超过这个大小的文件不进理解（也不复制），只记元信息
MAX_INGEST = 64 * 1024 * 1024
# 抽正文时最多读多少字符，太长的文件截断
MAX_TEXT = 1200
# 预读多少字节做类型嗅探
HEAD_LEN = 4096

KIND_LABEL = {
    'image': '图片', 'sticker': '表情包', 'voice': '语音',
    'video': '视频', 'file': '文件', 'other': '其他'
}
KIND_ORDER = ['sticker', 'image', 'voice', 'video', 'file', 'other']
# 去重时类别只升不降，数字越大越具体
KIND_RANK = {'other': 0, 'file': 1, 'image': 2, 'video': 3, 'voice': 4, 'sticker': 5}

# 微信截图里只有这些类型值得进素材库；文字消息的截图属于流水，不算素材
WX_KEEP = set(['image', 'sticker', 'voice', 'video', 'file', 'media'])

IMAGE_EXT = set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff'])
AUDIO_EXT = set(['.mp3', '.wav', '.amr', '.silk', '.ogg', '.m4a', '.flac', '.aac'])
VIDEO_EXT = set(['.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm'])
TEXT_EXT = set([
    '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.ini', '.conf',
    '.yml', '.yaml', '.xml', '.html', '.htm', '.py', '.js', '.ts', '.java', '.c',
    '.cpp', '.h', '.css', '.sql', '.sh', '.bat', '.tex', '.r'
])


def bj_day(ts=None):
    return time.strftime('%Y-%m-%d', time.gmtime((ts or time.time()) + TZ_OFF))


def bj_stamp(ts=None):
    return time.strftime('%Y-%m-%d %H:%M', time.gmtime(int(ts or time.time()) + TZ_OFF))


def log(msg):
    sys.stdout.write('[media] %s\n' % msg)
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
                pass
    return rows


def load_cfg():
    try:
        with open(CONFIG, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# 采集：把 inbox 里的文件和微信截图统一成同一种「候选条目」
# ---------------------------------------------------------------------------

def _safe_name(s):
    s = re.sub(r'[^\w.\-]+', '_', str(s or ''))
    return s.strip('._')[:40] or 'item'


def collect_qq():
    """QQ：读每天的 media-index.jsonl（observer.js 收到消息时写的）。"""
    out = []
    if not os.path.isdir(QQ_INBOX):
        return out
    for day in sorted(os.listdir(QQ_INBOX)):
        idx = os.path.join(QQ_INBOX, day, 'qq', 'media-index.jsonl')
        for r in read_jsonl(idx):
            f = r.get('file') or ''
            if not f:
                continue
            # 索引里的 file 是相对 .data 的（inbox/<日>/qq/x.jpg）
            path = f if os.path.isabs(f) else os.path.join(ROOT, f)
            if not os.path.exists(path):
                continue
            out.append({
                'platform': 'QQ',
                'type': r.get('type') or '',
                'name': r.get('name') or '',
                'chat': r.get('n') or r.get('id') or '',
                'chat_id': str(r.get('id') or ''),
                'sender': '',
                't': int(r.get('t') or 0),
                'mid': str(r.get('mid') or ''),
                'path': path,
                'st': int(r.get('st') or 0),
                'sz': int(r.get('sz') or 0),
                'em': r.get('em') or ''
            })
    return out


def collect_wx():
    """微信：4.1.26 拿不到原文件，只有气泡截图，归档行的 shot 字段指向它。"""
    out = []
    if not os.path.isdir(WX_ARCHIVE):
        return out
    for fn in sorted(os.listdir(WX_ARCHIVE)):
        if not fn.endswith('.jsonl'):
            continue
        for r in read_jsonl(os.path.join(WX_ARCHIVE, fn)):
            kind = r.get('k') or ''
            shot = r.get('shot') or ''
            if not shot or kind not in WX_KEEP:
                continue
            path = os.path.join(WX_INBOX, shot)
            if not os.path.exists(path):
                continue
            out.append({
                'platform': '微信',
                'type': kind,
                'name': '',
                'chat': r.get('n') or r.get('id') or '',
                'chat_id': str(r.get('id') or ''),
                'sender': r.get('sn') or '',
                't': int(r.get('t') or 0),
                'mid': str(r.get('mid') or ''),
                'path': path,
                'st': 0, 'sz': 0, 'em': '',
                # 微信 4.1.26 拿不到原文件，存档的只是一张**气泡截图**。
                # 截图本身是图片，不能按原消息类型当素材：把语音条标成「语音」
                # 会让人以为能听。类型记在 msgkind 里，kind 一律按 image 算。
                'shot': True,
                'msgkind': kind
            })
    return out


# ---------------------------------------------------------------------------
# 分类：光看 type 分不出「照片」和「表情包」
# ---------------------------------------------------------------------------

def sniff_ext(path):
    """按文件头判断真实扩展名。来源文件名常常没有后缀或后缀是错的。"""
    try:
        with open(path, 'rb') as f:
            h = f.read(HEAD_LEN)
    except Exception:
        return ''
    if h.startswith(b'\x89PNG'):
        return '.png'
    if h.startswith(b'\xff\xd8'):
        return '.jpg'
    if h.startswith(b'GIF8'):
        return '.gif'
    if h[:4] == b'RIFF' and h[8:12] == b'WEBP':
        return '.webp'
    if h[:4] == b'RIFF' and h[8:12] == b'WAVE':
        return '.wav'
    if h.startswith(b'%PDF'):
        return '.pdf'
    if h.startswith(b'PK\x03\x04'):
        return '.zip'
    if h.startswith(b'Rar!'):
        return '.rar'
    if h.startswith(b'7z\xbc\xaf'):
        return '.7z'
    if h.startswith(b'OggS'):
        return '.ogg'
    if h.startswith(b'#!AMR') or h.startswith(b'#!SILK'):
        return '.amr'
    if h.startswith(b'ID3') or h[:2] in (b'\xff\xfb', b'\xff\xf3'):
        return '.mp3'
    if h[4:8] == b'ftyp':
        return '.mp4'
    if h.startswith(b'\x1f\x8b'):
        return '.gz'
    return ''


def classify(it):
    """判定素材类别。返回 (kind, 判定理由)，理由会写进库里方便回溯。"""
    typ = (it['type'] or '').lower()
    ext = os.path.splitext(it['path'])[1].lower()
    name = it.get('name') or ''
    size = it.get('sz') or 0

    # 微信只有气泡截图。截图是图片，原消息类型只作说明，不能当素材类型用
    # （否则一条语音条会被标成「语音」，点开却是一张图）。
    if it.get('shot'):
        return 'image', '微信气泡截图（原消息：%s）' % KIND_LABEL.get(typ, typ or '?')
    if typ in ('mface', 'face', 'bface', 'sface'):
        return 'sticker', 'QQ 表情段 %s' % typ
    if typ in ('record', 'voice'):
        return 'voice', '语音段'
    if typ == 'video':
        return 'video', '视频段'
    if typ == 'sticker':
        return 'sticker', '微信表情'
    if typ == 'image':
        if it.get('em'):
            return 'sticker', '商城表情 emoji_id'
        if '表情' in name:
            return 'sticker', 'summary 标注表情'
        if it.get('st') in (6, 7):
            return 'sticker', 'image.sub_type=%s' % it.get('st')
        if ext == '.gif' and (size and size < 3 * 1024 * 1024):
            return 'sticker', '小体积 GIF'
        return 'image', '普通图片'
    if typ == 'file':
        if ext in IMAGE_EXT:
            return 'image', '以文件形式发的图片'
        if ext in AUDIO_EXT:
            return 'voice', '以文件形式发的音频'
        if ext in VIDEO_EXT:
            return 'video', '以文件形式发的视频'
        return 'file', '文件'
    if typ in ('media',):
        if ext in IMAGE_EXT:
            return 'image', '媒体-图片'
        return 'other', '媒体-未分类'
    return 'other', '未知类型 %s' % (typ or '?')


# ---------------------------------------------------------------------------
# 文件正文提取：服务器没有 pdftotext / unzip / ffmpeg，全走标准库
# ---------------------------------------------------------------------------

def _xml_text(raw):
    s = raw.decode('utf-8', 'replace')
    # 段落/行/单元格结束处补换行，否则整篇会挤成一行
    s = re.sub(r'</(w:p|a:p|w:tr|row|text:p)>', '\n', s)
    s = re.sub(r'<w:tab[^>]*/>', '\t', s)
    s = re.sub(r'<[^>]+>', '', s)
    return html.unescape(s)


def _zip_doc_text(path, ext):
    try:
        z = zipfile.ZipFile(path)
    except Exception:
        return ''
    names = z.namelist()
    parts = []
    try:
        if ext == '.docx':
            if 'word/document.xml' in names:
                parts.append(_xml_text(z.read('word/document.xml')))
        elif ext == '.xlsx':
            # 单元格的文字几乎全在 sharedStrings 里，比逐个 sheet 解析划算
            if 'xl/sharedStrings.xml' in names:
                parts.append(_xml_text(z.read('xl/sharedStrings.xml')))
        elif ext == '.pptx':
            slides = sorted(n for n in names
                            if re.match(r'ppt/slides/slide\d+\.xml$', n))
            for n in slides[:30]:
                parts.append(_xml_text(z.read(n)))
    except Exception:
        pass
    return ' '.join(parts)


def _zip_list(path):
    try:
        z = zipfile.ZipFile(path)
        names = z.namelist()
    except Exception:
        return ''
    more = '' if len(names) <= 40 else ' 等 %d 个' % len(names)
    return '压缩包内：' + '、'.join(names[:40]) + more


def _pdf_text(path):
    """PDF 正文。能抽英文/数字就返回，中文常见 CID 编码抽出来是乱码，宁可不给。"""
    try:
        raw = open(path, 'rb').read(8 * 1024 * 1024)
    except Exception:
        return ''
    chunks = []
    for m in re.finditer(br'stream\r?\n(.*?)endstream', raw, re.S):
        try:
            data = zlib.decompress(m.group(1))
        except Exception:
            continue
        for t in re.finditer(br'\((?:\\.|[^\\()]){2,}\)', data):
            s = t.group(0)[1:-1]
            s = re.sub(br'\\([()\\])', br'\1', s)
            try:
                chunks.append(s.decode('latin-1'))
            except Exception:
                pass
        if len(' '.join(chunks)) > MAX_TEXT * 3:
            break
    txt = ' '.join(chunks)
    txt = re.sub(r'\s+', ' ', txt).strip()
    # 可打印比例太低说明编码没解出来，别把乱码塞进库里
    if not txt:
        return ''
    ok = sum(1 for c in txt if 32 <= ord(c) < 127 or c.isspace())
    if len(txt) > 20 and ok / float(len(txt)) < 0.75:
        return ''
    return txt[:MAX_TEXT]


def file_text(path, ext):
    """抽取文件正文。返回 (text, 说明)。抽不到时 text 为空、说明写原因。"""
    if ext in TEXT_EXT:
        try:
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                return f.read(MAX_TEXT * 4)[:MAX_TEXT], ''
        except Exception:
            return '', '文本读取失败'
    if ext in ('.docx', '.xlsx', '.pptx'):
        t = _zip_doc_text(path, ext)
        t = re.sub(r'[ \t]+', ' ', t)
        t = re.sub(r'\n{3,}', '\n\n', t).strip()
        if not t:
            return '', 'Office 文件里没抽到文字（可能是纯图表/图片）'
        return t[:MAX_TEXT], ''
    if ext == '.pdf':
        t = _pdf_text(path)
        if not t:
            return '', 'PDF 正文抽不出来（中文 CID 编码需专用库），需人工查看'
        return t, ''
    if ext in ('.zip', '.jar', '.epub', '.apk'):
        t = _zip_list(path)
        return t, '' if t else '压缩包读取失败'
    if ext in ('.rar', '.7z', '.gz', '.tar'):
        return '', '压缩包需要外部工具解，未展开'
    if ext in ('.xls', '.doc', '.ppt'):
        return '', '老版 Office 二进制格式，未提取正文'
    if ext in IMAGE_EXT:
        return '', '图片内容由视觉模型描述'
    return '', '该类型未支持正文提取'


# ---------------------------------------------------------------------------
# 理解：视觉描述 + 标签 / 语音转写 / 文件正文
# ---------------------------------------------------------------------------

def _api_post(cfg, tail, payload, timeout=60):
    llm = cfg.get('llm') or {}
    key = llm.get('apiKey') or ''
    if not key:
        return None
    base = (llm.get('baseUrl') or 'https://api.siliconflow.cn/v1').rstrip('/')
    if not base.endswith('/v1'):
        base += '/v1'
    req = urllib.request.Request(
        base + tail, data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode('utf-8'))
    except Exception as e:
        log('模型调用失败 %s: %s' % (tail, e))
        return None


VISION_MODEL = 'Qwen/Qwen3-VL-32B-Instruct'
ASR_MODEL = 'FunAudioLLM/SenseVoiceSmall'

# Qwen3-VL 要求宽高都 > 28px，小图标/坏缩略图会被直接 400。
# 送之前先自己判一下，省一次失败请求，也别把「图太小」记成「理解失败」。
MIN_VISION_SIDE = 32


def image_size(path):
    """纯标准库读图片宽高。读不到返回 (0, 0)。"""
    try:
        with open(path, 'rb') as f:
            h = f.read(64 * 1024)
    except Exception:
        return 0, 0
    if h.startswith(b'\x89PNG') and len(h) >= 24:
        import struct as _s
        w, ht = _s.unpack('>II', h[16:24])
        return w, ht
    if h.startswith(b'GIF8') and len(h) >= 10:
        import struct as _s
        w, ht = _s.unpack('<HH', h[6:10])
        return w, ht
    if h.startswith(b'\xff\xd8'):
        i = 2
        while i + 9 < len(h):
            if h[i] != 0xFF:
                i += 1
                continue
            m = h[i + 1]
            if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB):
                return ((h[i + 7] << 8) | h[i + 8]), ((h[i + 5] << 8) | h[i + 6])
            seglen = (h[i + 2] << 8) | h[i + 3]
            i += 2 + seglen
    return 0, 0


DESC_PROMPT = (
    '看这张图，用一行中文回答，格式严格为：<一句话描述>|<标签1,标签2,标签3>\n'
    '描述要具体（画面内容、文字要点、情绪），不超过 30 字；'
    '标签用 2-4 个短词，便于以后检索。不要解释，不要换行。'
)

# 微信只有气泡截图，图里带着聊天背景、头像、时间戳。用原 prompt 会把
# 「截图边框」也描述进去（「一张微信聊天截图，右下角有绿色气泡」），
# 对检索毫无用处。这里明确要求只看消息内容本身。
SHOT_PROMPT = (
    '这是一条微信消息的气泡截图。忽略聊天背景、头像、时间戳和气泡边框，'
    '只描述这条消息本身：是图片、表情包、语音条、视频还是文件，内容是什么。\n'
    '用一行中文回答，格式严格为：<一句话描述>|<标签1,标签2,标签3>\n'
    '描述不超过 30 字（语音/视频请写出画面里的时长或文字），标签 2-4 个短词。'
    '不要解释，不要换行。'
)


def _vision_raw(cfg, path, prompt=None):
    """一次调用同时拿到描述和标签，比调两次省一半。"""
    w, h = image_size(path)
    if w and h and (w < MIN_VISION_SIDE or h < MIN_VISION_SIDE):
        return '', []
    try:
        b64 = base64.b64encode(open(path, 'rb').read()).decode('ascii')
    except Exception:
        return '', []
    mime = 'image/png' if path.lower().endswith('.png') else 'image/jpeg'
    d = _api_post(cfg, '/chat/completions', {
        'model': VISION_MODEL,
        'messages': [{'role': 'user', 'content': [
            {'type': 'text', 'text': prompt or DESC_PROMPT},
            {'type': 'image_url',
             'image_url': {'url': 'data:%s;base64,%s' % (mime, b64)}}
        ]}],
        'max_tokens': 120, 'temperature': 0.2, 'stream': False
    }, timeout=60)
    if not d:
        return '', []
    try:
        txt = (d['choices'][0]['message']['content'] or '').strip()
    except Exception:
        return '', []
    txt = txt.replace('\n', ' ').strip()
    if '|' in txt:
        desc, tags = txt.split('|', 1)
        taglist = [t.strip() for t in re.split(r'[,，、/]', tags) if t.strip()]
    else:
        desc, taglist = txt, []
    return desc.strip()[:80], taglist[:5]


def _asr(cfg, path):
    """语音转文字。multipart 用标准库手搓（服务器没 requests）。"""
    llm = cfg.get('llm') or {}
    key = llm.get('apiKey') or ''
    if not key:
        return ''
    base = (llm.get('baseUrl') or 'https://api.siliconflow.cn/v1').rstrip('/')
    if not base.endswith('/v1'):
        base += '/v1'
    try:
        raw = open(path, 'rb').read()
    except Exception:
        return ''
    if len(raw) > 20 * 1024 * 1024:
        return ''
    b = '----media%d' % int(time.time() * 1000)
    parts = []
    parts.append(('--%s\r\nContent-Disposition: form-data; name="model"\r\n\r\n%s\r\n'
                  % (b, ASR_MODEL)).encode('utf-8'))
    parts.append(('--%s\r\nContent-Disposition: form-data; name="file"; filename="v.mp3"\r\n'
                  'Content-Type: audio/mpeg\r\n\r\n' % b).encode('utf-8') + raw + b'\r\n')
    parts.append(('--%s--\r\n' % b).encode('utf-8'))
    req = urllib.request.Request(
        base + '/audio/transcriptions', data=b''.join(parts),
        headers={'Content-Type': 'multipart/form-data; boundary=' + b,
                 'Authorization': 'Bearer ' + key})
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            d = json.loads(res.read().decode('utf-8'))
        return (d.get('text') or '').strip()[:400]
    except Exception as e:
        log('ASR 失败: %s' % e)
        return ''


# ---------------------------------------------------------------------------
# 入库
# ---------------------------------------------------------------------------

def _drop_src(path):
    """删原件。只存文字，二进制的一个都不留。删不掉也不报错——下一轮还会来。"""
    if not path:
        return
    try:
        os.remove(path)
    except Exception:
        return
    _prune_dirs(os.path.dirname(path))


def backfill_wx_archive(lib, days=3):
    """把微信截图的理解结果写回归档正文。

    微信 4.1.26 拿不到原始文件：语音条、图片、视频、文件都只有一张气泡截图。
    截图理解完原件就删了（用户要求只存文字、省内存），所以**描述必须在删之前
    回到归档那一行**，否则这条消息永远只剩一个 `[语音条]`，等于白收——清单里
    就会出现「[语音条]（截图（素材库还没理解出来））」这种空壳行。

    对齐靠 `mid`：微信的 mid 是气泡图指纹，归档行和库条目存的都是它。
    已经有正文的行不覆盖（文字消息的正文是 OCR 出来的，比视觉描述准）。
    """
    if not os.path.isdir(WX_ARCHIVE):
        return 0
    need = {}
    for it in lib.values():
        if it.get('platform') != '微信' or not it.get('shot'):
            continue
        desc = (it.get('desc') or it.get('text') or '').strip()
        if desc and it.get('mid'):
            need[str(it['mid'])] = desc
    if not need:
        return 0
    today = bj_day()
    stamps = set()
    for d in range(days):
        stamps.add('wx-%s.jsonl' % bj_day(time.time() - d * 86400))
    n = 0
    for name in sorted(os.listdir(WX_ARCHIVE)):
        if name not in stamps and not name.endswith('.jsonl'):
            continue
        if not name.endswith('.jsonl'):
            continue
        p = os.path.join(WX_ARCHIVE, name)
        rows = read_jsonl(p)
        changed = False
        for r in rows:
            desc = need.get(str(r.get('mid') or ''))
            if not desc:
                continue
            cur = (r.get('x') or '').strip()
            if cur and not cur.startswith('['):
                continue                    # 已有真实正文，别用描述盖掉
            if cur == desc:
                continue
            r['x'] = desc
            r['shot'] = ''                  # 原件已删，路径留着只会让清单挂个空图
            changed = True
            n += 1
        if changed:
            tmp = p + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                for r in rows:
                    f.write(json.dumps(r, ensure_ascii=False) + '\n')
            os.replace(tmp, p)
    log('回填微信归档正文 %d 条' % n)
    return n


def _prune_dirs(d):
    """顺手清掉因此变空的目录（inbox/2026-11-10/qq/ 之类），别留一堆空壳。"""
    stops = [os.path.abspath(s) for s in (QQ_INBOX, WX_INBOX, ROOT) if s]
    while d:
        cur = os.path.abspath(d)
        if cur in stops or len(cur) < 5:
            return
        try:
            if os.listdir(cur):
                return
            os.rmdir(cur)
        except Exception:
            return
        d = os.path.dirname(d)


def sweep_old_src(days=None):
    """清掉超过 N 天还没理解掉的原件（一直失败的坏文件）。

    删文件的同时不能碰 media-index.jsonl：那是 QQ 的元信息索引，本身就是
    文字，留着不占地方，而且清单要靠它说明「这条曾经是什么」。
    """
    cut = time.time() - (days or KEEP_SRC_DAYS) * 86400
    n = 0
    for root in (QQ_INBOX, WX_INBOX):
        if not root or not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for fn in files:
                if fn == 'media-index.jsonl':
                    continue
                p = os.path.join(dirpath, fn)
                try:
                    if os.path.getmtime(p) < cut:
                        os.remove(p)
                        n += 1
                except Exception:
                    pass
    return n


def sha1_of(path):
    h = hashlib.sha1()
    try:
        with open(path, 'rb') as f:
            while True:
                b = f.read(1024 * 1024)
                if not b:
                    break
                h.update(b)
    except Exception:
        return ''
    return h.hexdigest()


def ingest(items):
    """去重入库。返回 {sha: 条目}，同一份内容只留一条，来源累加。"""
    os.makedirs(RAW, exist_ok=True)
    lib = {}
    skipped = 0
    for it in sorted(items, key=lambda x: x['t']):
        p = it['path']
        try:
            size = os.path.getsize(p)
        except Exception:
            continue
        if size <= 0:
            continue
        if size > MAX_INGEST:
            skipped += 1
            continue
        sha = sha1_of(p)
        if not sha:
            continue
        kind, why = classify(it)
        it['kind'] = kind
        it['why'] = why
        it['size'] = size

        src = {
            'platform': it['platform'], 'chat': it['chat'],
            'sender': it['sender'], 't': it['t'], 'mid': it['mid']
        }
        if sha in lib:
            old = lib[sha]
            # 同一内容被转发多次：保留最早的来源做主语，其余记进 users
            if len(old['users']) < 30:
                old['users'].append(src)
            # 类别只升不降：同一张图先当「图片」收到、后被当「表情包」发出来，
            # 应该记成表情包——表情包是更具体的语义，反过来则不该降级。
            if KIND_RANK.get(kind, 0) > KIND_RANK.get(old['kind'], 0):
                old['kind'] = kind
                old['why'] = why
            if it['t'] and (not old['t'] or it['t'] < old['t']):
                old['t'] = it['t']
                old['chat'] = it['chat']
                old['platform'] = it['platform']
            # 重复的那份原件直接删：库里已经有它的文字了，留着纯占地方
            _drop_src(it.get('src'))
            continue

        ext = os.path.splitext(p)[1].lower()
        real = sniff_ext(p)
        # 后缀和真实类型不一致时以文件头为准（微信截图常被命名成 .png 实际是 jpg）。
        # 例外：Office 文件本身就是 zip 容器，sniff 出 .zip 不代表要改后缀——
        # 改了就会被当压缩包只列文件名，正文提取直接丢。
        if real and real != ext:
            office = ('.docx', '.xlsx', '.pptx', '.jar', '.epub', '.apk')
            if not (real == '.zip' and ext in office):
                ext = real
        if not ext:
            ext = real or '.bin'
        lib[sha] = {
            'sha': sha, 'kind': kind, 'why': why, 'ext': ext,
            # 只存文字：原件**不复制**，留个源路径给 understand 用完就删
            'src': p,
            'size': size, 't': it['t'], 'platform': it['platform'],
            'chat': it['chat'], 'chat_id': it['chat_id'],
            'name': it['name'], 'mid': it['mid'],
            # 微信截图专用：原消息是什么类型（语音条/图片/视频…的截图）
            'msgkind': it.get('msgkind') or '',
            # 是不是气泡截图而不是原件——决定送视觉模型时用哪个 prompt
            'shot': bool(it.get('shot')),
            'users': [src],
            'desc': '', 'tags': [], 'text': '', 'note': ''
        }
    if skipped:
        log('跳过 %d 个超大文件（>%dMB）' % (skipped, MAX_INGEST // 1024 // 1024))
    return lib


def _src_of(it):
    """原件的当前路径。新条目在 src（临时），旧条目在 library/raw 下。"""
    s = it.get('src')
    if s and os.path.exists(s):
        return s
    f = it.get('file')
    if f:
        p = os.path.join(LIB, f)
        if os.path.exists(p):
            return p
    return ''


def understand(lib, cache, cfg, budget, use_llm=True):
    """给还没理解过的素材做理解。返回本次实际理解的数量。

    只存文字：每条理解成功后就地删掉原件（见 _drop_src），库里只剩描述/
    转写/正文。理解失败的留原件等重试，超龄由 sweep_old_src 收尾。
    """
    done = 0
    for sha in sorted(lib.keys(), key=lambda s: -lib[s]['t']):
        it = lib[sha]
        c = cache.get(sha)
        if c:
            it['desc'] = c.get('desc', '')
            it['tags'] = c.get('tags', []) or []
            it['text'] = c.get('text', '')
            it['note'] = c.get('note', '')
            # 成功过的（没有 failAt）永远复用；**失败过的要退避**：入库 cron
            # 已经改成每分钟一次，不退避的话一张坏图会变成每分钟一次无效请求。
            left = FAIL_BACKOFF - (time.time() - (c.get('failAt') or 0))
            if not c.get('failAt') or left > 0:
                # 已经理解过的内容又被转发了：库里早有文字，新原件不必留
                _drop_src(it.get('src'))
                continue
        p = _src_of(it)
        if it['kind'] in ('image', 'sticker'):
            if not use_llm or done >= budget:
                continue
            if not p:
                it['note'] = '原件已清理，无法再理解'
                continue
            # 太小的图模型直接拒（400），先自己判掉并写进缓存，
            # 否则每轮都当成「失败」重试，白烧时间和日志。
            w, h = image_size(p)
            if w and h and (w < MIN_VISION_SIDE or h < MIN_VISION_SIDE):
                it['note'] = '图太小（%dx%d），不做视觉理解' % (w, h)
                cache[sha] = {'desc': '', 'tags': [], 'text': '', 'note': it['note']}
                _drop_src(it.get('src'))
                continue
            desc, tags = _vision_raw(cfg, p,
                                     SHOT_PROMPT if it.get('shot') else None)
            if desc:
                it['desc'], it['tags'] = desc, tags
                cache[sha] = {'desc': desc, 'tags': tags, 'text': '', 'note': ''}
                _drop_src(it.get('src'))
                done += 1
            else:
                it['note'] = '视觉理解失败，稍后重试'
                cache[sha] = {'desc': '', 'tags': [], 'text': '',
                              'note': it['note'], 'failAt': time.time()}
        elif it['kind'] == 'voice':
            if not use_llm or done >= budget:
                continue
            if not p:
                it['note'] = '原件已清理，无法再转写'
                continue
            txt = _asr(cfg, p)
            if txt:
                it['text'] = txt
                cache[sha] = {'desc': '', 'tags': [], 'text': txt, 'note': ''}
                _drop_src(it.get('src'))
                done += 1
            else:
                it['note'] = '语音转写失败，稍后重试'
                cache[sha] = {'desc': '', 'tags': [], 'text': '',
                              'note': it['note'], 'failAt': time.time()}
        elif it['kind'] == 'file':
            # 文件抽正文不花钱，不受 budget 限制
            if not p:
                it['note'] = '原件已清理，无法再抽正文'
                continue
            txt, note = file_text(p, it['ext'])
            it['text'], it['note'] = txt, note
            cache[sha] = {'desc': '', 'tags': [], 'text': txt, 'note': note}
            _drop_src(it.get('src'))
        elif it['kind'] == 'video':
            # 服务器没有 ffmpeg，视频只能记元信息；原件直接删，只留这一行
            it['note'] = '服务器无 ffmpeg，只记时长/大小，不留原件'
            cache[sha] = {'desc': '', 'tags': [], 'text': '',
                          'note': it['note']}
            _drop_src(it.get('src'))
    return done


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------

def render_md(lib):
    by_kind = {}
    for it in lib.values():
        by_kind.setdefault(it['kind'], []).append(it)
    total = len(lib)
    head = ['# 素材库', '',
            '更新于 %s ｜ 共 **%d** 个素材：%s' % (
                bj_stamp(), total,
                ' · '.join('%s %d' % (KIND_LABEL.get(k, k), len(by_kind.get(k, [])))
                           for k in KIND_ORDER if by_kind.get(k))),
            '',
            '> **只存文字**：图片/表情只留一句描述，语音只留转写，文件只留正文摘要，'
            '原件理解完即删。同一份内容被转发多次只存一份，来源记在「来源」里。',
            '',
            '## 目录', '']
    for k in KIND_ORDER:
        rows = by_kind.get(k) or []
        if rows:
            head.append('- [%s（%d）](#%s)' % (KIND_LABEL.get(k, k), len(rows), k))
    lines = list(head)
    for k in KIND_ORDER:
        rows = sorted(by_kind.get(k) or [], key=lambda x: -x['t'])
        if not rows:
            continue
        lines += ['', '## %s（%d）' % (KIND_LABEL.get(k, k), len(rows)), '']
        for it in rows:
            title = (it.get('desc') or it.get('name') or it.get('text') or '').strip()
            if not title:
                # 语音/视频/文件没有现成标题时，用「类型 + 大小」比一串文件名好认
                title = '%s %s' % (KIND_LABEL.get(k, k), _human(it['size']))
            title = re.sub(r'\s+', ' ', title)[:60]
            lines.append('### %s' % re.sub(r'\s+', ' ', title))
            lines.append('')
            if it.get('tags'):
                lines.append('- 标签：%s' % '、'.join(it['tags']))
            if it.get('text'):
                t = it['text'].replace('\n', ' ').strip()
                lines.append('- 内容：%s' % (t[:400] + ('…' if len(t) > 400 else '')))
            if it.get('msgkind'):
                lines.append('- 说明：微信气泡截图，原消息是%s（Linux 客户端拿不到原始文件）'
                             % KIND_LABEL.get(it['msgkind'], it['msgkind']))
            if it.get('note'):
                lines.append('- 备注：%s' % it['note'])
            lines.append('- 来源：%s · %s · %s' % (
                it['platform'], it['chat'] or '（未知会话）', bj_stamp(it['t']) if it['t'] else '时间未知'))
            if len(it['users']) > 1:
                extra = '、'.join('%s/%s' % (u['platform'], u['chat'] or '?')
                                  for u in it['users'][1:6])
                lines.append('- 另被 %s 转发过' % extra)
            lines.append('- 大小：%s（原件已清理）' % _human(it['size']))
            lines.append('')
    return '\n'.join(lines) + '\n'


def _human(n):
    for unit in ('B', 'KB', 'MB', 'GB'):
        if n < 1024 or unit == 'GB':
            return '%.1f %s' % (n, unit) if unit != 'B' else '%d B' % n
        n /= 1024.0


def save(lib, cache):
    os.makedirs(LIB, exist_ok=True)
    tmp = LIB_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        for it in sorted(lib.values(), key=lambda x: (x['kind'], -x['t'])):
            # src 是「这一轮还没删的临时原件路径」，落盘没意义（下次读回来
            # 文件已经不在了），还会让库文件里留一堆失效路径。
            row = dict(it)
            row.pop('src', None)
            f.write(json.dumps(row, ensure_ascii=False) + '\n')
    os.replace(tmp, LIB_FILE)
    tmp = DESC_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False)
    os.replace(tmp, DESC_FILE)
    with open(MD_FILE, 'w', encoding='utf-8') as f:
        f.write(render_md(lib))


def main():
    limit = MAX_UNDERSTAND
    use_llm = True
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a == '--limit' and i + 1 < len(args):
            limit = int(args[i + 1])
        if a == '--no-llm':
            use_llm = False
        if a == '--rebuild':
            for p in (LIB_FILE, DESC_FILE):
                if os.path.exists(p):
                    os.remove(p)

    cfg = load_cfg()
    cache = {}
    if os.path.exists(DESC_FILE):
        try:
            cache = json.load(open(DESC_FILE, 'r', encoding='utf-8'))
        except Exception:
            cache = {}

    qq = collect_qq()
    wx = collect_wx()
    # 超龄原件（一直理解失败的坏文件）每轮顺手清一次，别让它们永久占盘
    swept = sweep_old_src()

    # 已经理解过的素材也要带上（去重后可能这一轮没有任何候选）
    lib = {}
    if os.path.exists(LIB_FILE):
        for r in read_jsonl(LIB_FILE):
            sha = r.get('sha')
            if sha:
                r.setdefault('users', [])
                lib[sha] = r

    # 回填要放在**短路之前**：上一轮理解完的微信截图，原件可能已经被清掉，
    # 而描述还没进归档。库是刚读出来的内存对象，没有待回填条目时这一步
    # 连一个文件都不读（`need` 为空立刻返回），空转成本可忽略。
    try:
        backfill_wx_archive(lib)
    except Exception as e:
        log('回填微信归档失败：%s' % e)

    # 没有候选、库也建好了就直接退出。cron 改成每分钟跑之后，这条短路让
    # 空转的成本只剩两次目录扫描（毫秒级），新素材最多两分钟就能在面板里看到，
    # 不必跟以前一样等整点。理解次数不受影响：understand 只处理没理解过的，
    # 总调用量由素材数量决定，跟跑多勤无关。
    if not qq and not wx and os.path.exists(LIB_FILE):
        return 0
    log('候选：QQ %d 个，微信 %d 个%s' % (len(qq), len(wx),
                                  '，清理超龄原件 %d 个' % swept if swept else ''))

    new = ingest(qq + wx)
    added = 0
    for sha, it in new.items():
        if sha in lib:
            # 已在库里：把新来源并进去
            old = lib[sha]
            for u in it['users']:
                if u not in old['users'] and len(old['users']) < 30:
                    old['users'].append(u)
            # 内容早就理解过了，这份新到的原件没必要留（只存文字）
            _drop_src(it.get('src'))
        else:
            lib[sha] = it
            added += 1
    log('入库：新增 %d 个，库内共 %d 个（去重后）' % (added, len(lib)))

    got = understand(lib, cache, cfg, limit, use_llm)
    log('本次理解 %d 个%s' % (got, '' if use_llm else '（--no-llm，只抽了文件正文）'))

    # 理解完立刻回填归档：截图原件马上要被 sweep 清掉，描述不回填就永久丢失。
    try:
        backfill_wx_archive(lib)
    except Exception as e:
        log('回填微信归档失败：%s' % e)

    save(lib, cache)
    counts = {}
    for it in lib.values():
        counts[it['kind']] = counts.get(it['kind'], 0) + 1
    log('素材库：%s' % (' · '.join('%s %d' % (KIND_LABEL.get(k, k), counts[k])
                                  for k in KIND_ORDER if k in counts) or '空'))
    log('产物：%s、%s' % (MD_FILE, LIB_FILE))
    return 0


if __name__ == '__main__':
    sys.exit(main())
