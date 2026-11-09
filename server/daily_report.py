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
OUT_DIR = os.environ.get('DAILY_OUT', os.path.join(ROOT, 'daily'))

MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash'
VISION_MODEL = 'Qwen/Qwen3-VL-32B-Instruct'
ASR_MODEL = 'FunAudioLLM/SenseVoiceSmall'
MAX_MODEL_CHARS = 14000          # 喂给模型的流水上限，防超长
MAX_MEDIA_COPY = 20 * 1024 * 1024  # 单个媒体超过 20MB 只留路径不复制
MAX_ENRICH = 60                  # 每天最多转写/描述多少个媒体，防限流和烧钱
                                 # 微信每条消息都带截图，30 不够用，放宽到 60

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
    wx_paths = [
        os.path.join(WX_ARCHIVE, 'wx-' + day + '.jsonl'),
        '/opt/linux-im/archive/wx-' + day + '.jsonl'
    ]
    seen = set()
    for p in wx_paths:
        if not os.path.exists(p):
            continue
        for r in read_jsonl(p):
            key = (r.get('t'), r.get('id'), r.get('x'), r.get('k'))
            if key in seen:
                continue
            seen.add(key)
            out.append(normalize(r, '微信'))
        # 两个来源都读：wechat/ 是宿主机每分钟同步的副本（可能滞后一分钟），
        # /opt/linux-im/archive 是容器直接写的原件。取并集去重才不会漏掉
        # 刚生成清单前几秒进来的最后一条消息。
    out.sort(key=lambda m: m['t'])
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
        'chat': r.get('n') or r.get('id') or '?',
        'chat_type': '群聊' if r.get('c') == 'group' else '',
        'text': str(r.get('x') or ''),
        'kinds': kinds,
        'labels': labels,
        'medias': medias,
        'shot': r.get('shot') or '',
        'mid': r.get('mid') or '',
        'me': bool(r.get('me')),
        'no': ''
    }


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


def attach_media(msgs, index, day, media_dir):
    """把索引里的文件复制进清单目录，返回媒体清单与每条消息的缩略图。"""
    # 按 (平台, mid) 预先分组，别在消息循环里遍历整张索引（O(n²)）
    by_mid = {}
    for (p, mid, i), rr in index.items():
        by_mid.setdefault((p, str(mid)), []).extend(rr)
    gallery = []
    for m in msgs:
        plat = 'QQ' if m['platform'] in ('QQ', 'qq') else '微信'
        m['files'] = []
        # 微信截图直接来自归档的 shot 字段
        if m['shot']:
            src = os.path.join(WX_INBOX, m['shot'])
            item = copy_media(src, media_dir, plat, m, '截图')
            if item:
                m['files'].append(item)
                gallery.append(item)
        for r in by_mid.get((plat, str(m['mid'])), []):
            f = r.get('file') or ''
            if not f:
                continue
            src = f if os.path.isabs(f) else os.path.join(
                QQ_INBOX if plat == 'QQ' else WX_INBOX, f)
            # QQ 索引里的 file 是相对 .data 的（inbox/<日期>/qq/…）
            if plat == 'QQ' and f.startswith('inbox/'):
                src = os.path.join(ROOT, f)
            item = copy_media(src, media_dir, plat, m,
                              KIND_LABEL.get(r.get('type'), r.get('type') or '媒体'))
            if item:
                m['files'].append(item)
                gallery.append(item)
    return gallery


def copy_media(src, media_dir, plat, m, label):
    if not src or not os.path.exists(src):
        return None
    try:
        size = os.path.getsize(src)
    except Exception:
        return None
    name = '%s_%s_%s' % (m['no'], re.sub(r'\W+', '_', plat), os.path.basename(src))
    name = re.sub(r'[^\w.\-]', '_', name)[:120]
    dst = os.path.join(media_dir, name)
    local = name if size <= MAX_MEDIA_COPY else ''
    if local:
        try:
            if not os.path.exists(dst):
                shutil.copy2(src, dst)
        except Exception:
            local = ''
    return {'label': label, 'path': src, 'local': local,
            'size': size, 'chat': m['chat'], 'time': bj_time(m['t']),
            'platform': plat, 'no': m['no']}


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
        log('媒体理解失败 %s: %s' % (tail, e))
        return None


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
    b = '----daily%d' % int(time.time() * 1000)
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
        with urllib.request.urlopen(req, timeout=60) as res:
            d = json.loads(res.read().decode('utf-8'))
        return (d.get('text') or '').strip()[:300]
    except Exception as e:
        log('ASR 失败: %s' % e)
        return ''


def _vision(cfg, path, prompt):
    """让视觉模型读一张图。QQ 的原图与微信的气泡截图都走这里。"""
    try:
        b64 = base64.b64encode(open(path, 'rb').read()).decode('ascii')
        mime = 'image/png' if path.lower().endswith('.png') else 'image/jpeg'
        d = _api_post(cfg, '/chat/completions', {
            'model': VISION_MODEL,
            'messages': [{'role': 'user', 'content': [
                {'type': 'text', 'text': prompt},
                {'type': 'image_url',
                 'image_url': {'url': 'data:%s;base64,%s' % (mime, b64)}}
            ]}],
            'max_tokens': 80, 'temperature': 0.2, 'stream': False
        }, timeout=60)
        if d:
            return (d['choices'][0]['message']['content'] or '').strip()[:100]
    except Exception as e:
        log('视觉描述失败: %s' % e)
    return ''


def enrich_media(msgs, gallery, cfg, out_day):
    """媒体做内容理解：QQ 语音转文字、QQ 原图/微信截图生成描述。

    用户要的是「以待后续处理」的清单——只丢一个 [语音] 标记或一个
    「鱼 / 可 / 做」这种 OCR 噪声没法处理，必须能读到里面是什么。
    微信 4.1.26 拿不到原始文件，但**气泡截图本身就是图**，视觉模型能
    读出卡片文字、认出表情和图片内容，所以一样要理解，不能只挂着链接。
    结果缓存到 media_desc.json，重跑不重复烧钱。
    """
    cache_path = os.path.join(out_day, 'media_desc.json')
    cache = {}
    if os.path.exists(cache_path):
        try:
            cache = json.load(open(cache_path, 'r', encoding='utf-8'))
        except Exception:
            cache = {}
    done = 0
    for f in gallery:
        if not f['local']:
            continue
        key = f['path']
        if key in cache:
            desc = cache[key]
        elif done >= MAX_ENRICH:
            continue
        else:
            p = os.path.join(out_day, 'media', f['local'])
            typ = f['label']
            desc = ''
            if typ in ('语音', '语音条'):
                desc = _asr(cfg, p)
            elif typ == '截图':
                desc = _vision(cfg, p,
                               '这是微信消息气泡的截图。用一句中文概括这条消息：'
                               '如果是文字或卡片，写出主要内容；如果是图片/表情/'
                               '语音条/视频/文件，说明类型和画面。40字内，不要解释。')
            elif typ in ('图片', '表情包', '表情', '视频'):
                desc = _vision(cfg, p,
                               '用一句中文说明这张图/表情包的内容或表达的情绪，20字内，不要解释。')
            # 失败的（空描述）不要写进缓存：定时报告每小时重跑一次，
            # 让限流/网络抖动能在下一轮自己恢复，别把失败固化住。
            if desc:
                cache[key] = desc
            done += 1
        f['desc'] = desc
        if desc:
            # 描述回填到对应消息，流水和待办提炼都能读到
            for m in msgs:
                if m['no'] == f['no']:
                    if not m['text'] or m['text'].startswith('['):
                        m['text'] = desc
                    else:
                        m['text'] += '（%s）' % desc
                    break
    try:
        with open(cache_path, 'w', encoding='utf-8') as fh:
            json.dump(cache, fh, ensure_ascii=False, indent=1)
    except Exception:
        pass
    return sum(1 for f in gallery if f.get('desc'))


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


def call_llm(cfg, flow):
    llm = cfg.get('llm') or {}
    key = llm.get('apiKey') or ''
    base = (llm.get('baseUrl') or 'https://api.siliconflow.cn/v1').rstrip('/')
    if not key:
        return None, '未配置 apiKey'
    body = {
        'model': MODEL,
        'messages': [
            {'role': 'system', 'content': TODO_PROMPT},
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
    L.append('> 只收不发的监听记录｜共 %d 条消息、%d 个会话、%d 个媒体文件' % (
        len(msgs), len(group_by_chat(msgs)), len(gallery)))
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
            q = t.get('quote') or ''
            if q:
                L.append('      - 原话：%s（%s）' % (q, t.get('ref', '')))
    L.append('')
    if summary:
        L.append('**今日概括**：%s' % summary)
        L.append('')
    L.append('## 二、全量流水')
    L.append('')
    for (plat, chat), rows in group_by_chat(msgs):
        L.append('### %s · %s（%d 条）' % (plat, chat, len(rows)))
        L.append('')
        for m in rows:
            tags = (' `' + '/'.join(m['labels']) + '`') if m['labels'] else ''
            body = m['text'].replace('\n', ' ') or '（无文字）'
            L.append('- `%s` **%s**：%s%s' % (bj_time(m['t']), m['who'], body, tags))
            for f in m.get('files') or []:
                if f['local']:
                    L.append('  - [%s](media/%s)' % (f['label'], f['local']))
                else:
                    L.append('  - %s：%s' % (f['label'], f['path']))
        L.append('')
    if gallery:
        L.append('## 三、媒体文件清单')
        L.append('')
        L.append('| 时间 | 平台 | 会话 | 类型 | 转写/描述 | 文件 |')
        L.append('|---|---|---|---|---|---|')
        for f in gallery:
            # 清单目录要能整包拷走离线看，所以给的是 media/ 里的相对链接，
            # 不是服务器上的源绝对路径（后者拷走后必然失效，还把目录结构暴露出去）。
            if f['local']:
                cell = '[`%s`](media/%s)' % (f['local'], f['local'])
            else:
                cell = '`%s`（超过 %dMB，未随清单复制）' % (
                    os.path.basename(f['path']), MAX_MEDIA_COPY // 1024 // 1024)
            L.append('| %s | %s | %s | %s | %s | %s |' % (
                f['time'], f['platform'], f['chat'], f['label'],
                (f.get('desc') or '—').replace('|', '/'), cell))
        L.append('')
    L.append('---')
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
    P.append('<div class="meta">只收不发的监听记录｜%d 条消息 · %d 个会话 · %d 个媒体文件</div>' % (
        len(msgs), len(group_by_chat(msgs)), len(gallery)))
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
            P.append('<div class="quote">原话：%s （%s）</div>' % (
                E(str(t['quote'])), E(str(t.get('ref', '')))))
        P.append('</div></label>')
    if summary:
        P.append('<h2>今日概括</h2><div class="summary">%s</div>' % E(str(summary)))
    P.append('<h2>二、全量流水</h2>')
    for (plat, chat), rows in group_by_chat(msgs):
        P.append('<h3>%s · %s（%d 条）</h3><div class="flow">' % (
            E(str(plat)), E(str(chat)), len(rows)))
        for m in rows:
            tags = ''.join('<span class="kind">%s</span>' % E(x) for x in m['labels'])
            P.append('<div class="row"><span class="ts">%s</span>'
                     '<span class="who">%s</span><span class="txt">%s%s</span></div>' % (
                         bj_time(m['t']), E(m['who']),
                         E(m['text'].replace('\n', ' ') or '（无文字）'), tags))
            imgs = [f for f in (m.get('files') or []) if f['local']]
            if imgs:
                P.append('<div class="thumbs">')
                for f in imgs:
                    P.append('<a href="media/%s" target="_blank"><img src="media/%s" '
                             'alt="%s"><div class="cap">%s</div></a>' % (
                                 E(f['local']), E(f['local']), E(f['label']), E(f['label'])))
                P.append('</div>')
        P.append('</div>')
    if gallery:
        P.append('<h2>三、媒体文件清单</h2><table><tr><th>时间</th><th>平台</th>'
                 '<th>会话</th><th>类型</th><th>转写/描述</th><th>文件</th></tr>')
        for f in gallery:
            if f['local']:
                cell = '<a href="media/%s" target="_blank"><code>%s</code></a>' % (
                    E(f['local']), E(f['local']))
            else:
                cell = '<code>%s</code>（超过 %dMB，未随清单复制）' % (
                    E(os.path.basename(f['path'])), MAX_MEDIA_COPY // 1024 // 1024)
            P.append('<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td>'
                     '<td>%s</td></tr>' % (
                         f['time'], E(f['platform']), E(str(f['chat'])), E(f['label']),
                         E(str(f.get('desc') or '—')), cell))
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
    media_dir = os.path.join(out_day, 'media')
    os.makedirs(media_dir, exist_ok=True)

    msgs = load_messages(day)
    index = load_media_index(day)
    gallery = attach_media(msgs, index, day, media_dir)
    log('%s: %d 条消息, %d 个媒体文件' % (day, len(msgs), len(gallery)))

    cfg = load_config()
    if gallery and not a.no_llm:
        n = enrich_media(msgs, gallery, cfg, out_day)
        log('媒体内容理解：%d 个拿到描述/转写' % n)

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
