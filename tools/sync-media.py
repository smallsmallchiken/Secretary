#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把服务器上的「收到的素材库」同步回本地，供桌宠素材库面板浏览。

只同步**文字**：索引 library.jsonl + 渲染好的 素材库.md。

以前还会把图片/表情的原文件拉回来给面板预览，现在素材库只存文字——
原件在服务器上理解完就删了，也没有可拉的东西。这样本地也不会被
几千张截图撑大。

凭据从 .data/config.json 的 server 段读——仓库是 public，脚本里不写口令。
"""

import json
import os
import sys

import paramiko

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE = '/opt/secretary/.data/media/received'
LOCAL = os.path.join(HERE, '.data', 'media', 'received')


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


def pull(sftp, rel, local_root):
    """下载一个文件，返回 'ok' / 'fail'。大小没变就跳过。"""
    remote = REMOTE + '/' + rel
    dst = os.path.join(local_root, rel.replace('/', os.sep))
    try:
        st = sftp.stat(remote)
    except IOError:
        return 'fail'
    if os.path.exists(dst) and os.path.getsize(dst) == st.st_size:
        return 'ok'
    ensure(os.path.dirname(dst))
    tmp = dst + '.part'
    sftp.get(remote, tmp)
    if os.path.exists(dst):
        os.remove(dst)
    os.rename(tmp, dst)
    return 'ok'


def main():
    host, user, pwd = creds()
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, username=user, password=pwd, timeout=60, banner_timeout=120)
    sftp = c.open_sftp()
    ensure(LOCAL)

    ok = fail = 0
    for name in ('library.jsonl', '素材库.md'):
        if pull(sftp, name, LOCAL) == 'ok':
            ok += 1
        else:
            fail += 1
    sftp.close()
    c.close()

    idx = []
    p = os.path.join(LOCAL, 'library.jsonl')
    if os.path.exists(p):
        with open(p, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    idx.append(json.loads(line))
                except ValueError:
                    pass

    counts = {}
    for it in idx:
        k = it.get('kind') or 'other'
        counts[k] = counts.get(k, 0) + 1
    label = {'image': '图片', 'sticker': '表情包', 'voice': '语音',
             'video': '视频', 'file': '文件', 'other': '其他'}
    summary = ' · '.join('%s %d' % (label.get(k, k), v)
                         for k, v in sorted(counts.items())) or '空'
    print('同步完成：文件 %d 成功、%d 失败（只同步文字，不拉原件）' % (ok, fail))
    print('库内：%s' % summary)
    print('本地：%s' % LOCAL)
    return 0


if __name__ == '__main__':
    sys.exit(main())
