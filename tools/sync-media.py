#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把服务器上的「收到的素材库」同步回本地，供桌宠素材库面板浏览。

服务器侧由 media_lib.py 负责入库与理解（视觉描述、语音转写、文件正文），
这里只做搬运：索引、Markdown、以及**能直接预览的小文件**（图片/表情）。
语音、视频、原文件体积大，默认只同步元数据，加 --all 才拉。

凭据从 .data/config.json 的 server 段读——仓库是 public，脚本里不写口令。
"""

import json
import os
import sys

import paramiko

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE = '/opt/secretary/.data/media/received'
LOCAL = os.path.join(HERE, '.data', 'media', 'received')
# 单文件超过这个大小不下载：面板里只显示元数据，避免本地被视频/大图撑爆
MAX_PULL = 3 * 1024 * 1024


def creds():
    p = os.path.join(HERE, '.data', 'config.json')
    with open(p, 'r', encoding='utf-8') as f:
        d = json.load(f)
    s = d.get('server') or {}
    host = s.get('host') or s.get('ip')
    user = s.get('user') or s.get('username') or 'root'
    pwd = s.get('password') or s.get('pwd')
    if not host or not pwd:
        raise SystemExit('缺少服务器凭据：.data/config.json 的 server 段')
    return host, user, pwd


def ensure(d):
    if not os.path.isdir(d):
        os.makedirs(d)


def pull(sftp, rel, local_root, max_size=None):
    """下载一个文件，返回 'ok' / 'skip' / 'fail'。"""
    remote = REMOTE + '/' + rel
    dst = os.path.join(local_root, rel.replace('/', os.sep))
    try:
        st = sftp.stat(remote)
    except IOError:
        return 'fail'
    if max_size is not None and st.st_size > max_size:
        return 'skip'
    needs = True
    if os.path.exists(dst) and os.path.getsize(dst) == st.st_size:
        needs = False
    if needs:
        ensure(os.path.dirname(dst))
        tmp = dst + '.part'
        sftp.get(remote, tmp)
        if os.path.exists(dst):
            os.remove(dst)
        os.rename(tmp, dst)
    return 'ok'


def main():
    all_files = '--all' in sys.argv
    host, user, pwd = creds()
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, username=user, password=pwd, timeout=60, banner_timeout=120)
    sftp = c.open_sftp()
    ensure(LOCAL)

    ok = skip = fail = 0
    # 1) 索引与 Markdown 必拉
    for name in ('library.jsonl', '素材库.md'):
        r = pull(sftp, name, LOCAL)
        if r == 'ok':
            ok += 1
        else:
            fail += 1

    # 2) 读本地索引，决定哪些原文件要下
    idx = []
    p = os.path.join(LOCAL, 'library.jsonl')
    if os.path.exists(p):
        with open(p, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        idx.append(json.loads(line))
                    except ValueError:
                        pass

    for it in idx:
        f = it.get('file') or ''
        if not f:
            continue
        # 图片/表情是面板要预览的，必须下；其余默认只留元数据
        kind = it.get('kind')
        if all_files:
            lim = None
        elif kind in ('image', 'sticker'):
            lim = MAX_PULL
        else:
            continue
        r = pull(sftp, f, LOCAL, lim)
        if r == 'ok':
            ok += 1
        elif r == 'skip':
            skip += 1
        else:
            fail += 1

    sftp.close()
    c.close()
    counts = {}
    for it in idx:
        counts[it.get('kind')] = counts.get(it.get('kind'), 0) + 1
    label = {'image': '图片', 'sticker': '表情包', 'voice': '语音',
             'video': '视频', 'file': '文件', 'other': '其他'}
    summary = ' · '.join('%s %d' % (label.get(k, k), v)
                         for k, v in sorted(counts.items())) or '空'
    print('同步完成：下载 %d，跳过 %d（超 %dMB），失败 %d' % (
        ok, skip, MAX_PULL // 1024 // 1024, fail))
    print('库内：%s' % summary)
    print('本地：%s' % LOCAL)
    return 0


if __name__ == '__main__':
    sys.exit(main())
