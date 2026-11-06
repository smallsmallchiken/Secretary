#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把服务器上的每日清单同步回本地工作区（含媒体缩略图）。

服务器是唯一生成方，这里只读、只拉取，不改服务器任何配置：
  /opt/secretary/.data/daily/latest.md|latest.html   最新清单
  /opt/secretary/.data/daily/<YYYY-MM-DD>/daily.md|daily.html|media/*

凭据沿用 tools/sync-archive.py 的约定，从 .data/config.json 的 server 段读，
不写死在脚本里（仓库是 public，明文密码绝不能进 git）。

    python tools/sync-daily.py                 # 最新清单 + 最近 7 天
    python tools/sync-daily.py --date 2026-10-31
    python tools/sync-daily.py --days 30      # 多拉几天
"""
import argparse
import json
import os
import posixpath
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

import paramiko

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, '.data', 'config.json')
REMOTE = '/opt/secretary/.data/daily'
LOCAL = os.path.join(ROOT, '.data', 'daily')
DATE_DIR_NAMES = True  # 日期目录形如 2026-10-31，长度 10


def load_server_cfg():
    with open(CONFIG, 'r', encoding='utf-8') as f:
        cfg = (json.load(f).get('server') or {})
    host = cfg.get('host')
    user = cfg.get('user') or 'root'
    pwd = cfg.get('password')
    if not host or not pwd:
        raise RuntimeError('.data/config.json 的 server 段缺 host/password')
    return host, user, pwd, int(cfg.get('port') or 22)


def walk(sftp, rdir):
    """递归列出远端文件，返回 [(remote_path, st_size, st_mtime)]。"""
    out = []
    try:
        for e in sftp.listdir_attr(rdir):
            rp = posixpath.join(rdir, e.filename)
            if e.st_mode & 0o40000:
                out.extend(walk(sftp, rp))
            else:
                out.append((rp, e.st_size or 0, e.st_mtime or 0))
    except IOError:
        pass
    return out


def need_pull(lp, size, mtime):
    if not os.path.exists(lp):
        return True
    if os.path.getsize(lp) != size:
        return True
    # 清单每天会重跑（--yesterday 补跑昨天的），大小可能一样但内容变了
    return mtime > os.path.getmtime(lp) + 1


def pull_one(sftp, rp, lp, size, mtime):
    if not need_pull(lp, size, mtime):
        return False
    parent = os.path.dirname(lp)
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    sftp.get(rp, lp)
    try:
        os.utime(lp, (mtime, mtime))
    except Exception:
        pass
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date', default='', help='只同步某一天')
    ap.add_argument('--days', type=int, default=7, help='不带 --date 时同步最近 N 天')
    a = ap.parse_args()

    host, user, pwd, port = load_server_cfg()
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, port=port, username=user, password=pwd,
              timeout=60, banner_timeout=120)
    s = c.open_sftp()

    n = 0
    # 1) 顶层 latest.md / latest.html
    for name in ('latest.md', 'latest.html'):
        rp = posixpath.join(REMOTE, name)
        try:
            st = s.stat(rp)
        except IOError:
            continue
        if pull_one(s, rp, os.path.join(LOCAL, name), st.st_size or 0, st.st_mtime or 0):
            n += 1

    # 2) 日期目录（含 media/）
    try:
        all_days = sorted(e.filename for e in s.listdir_attr(REMOTE)
                          if e.st_mode & 0o40000 and len(e.filename) == 10
                          and e.filename[4] == '-' and e.filename[7] == '-')
    except IOError:
        all_days = []
    days = [a.date] if a.date else all_days[-a.days:]
    for d in days:
        rdir = posixpath.join(REMOTE, d)
        for rp, size, mtime in walk(s, rdir):
            rel = posixpath.relpath(rp, REMOTE).replace('/', os.sep)
            if pull_one(s, rp, os.path.join(LOCAL, rel), size, mtime):
                n += 1

    s.close()
    c.close()
    print('同步 %d 个文件 -> %s' % (n, LOCAL))
    latest = os.path.join(LOCAL, 'latest.html')
    print('最新清单：%s' % (latest if os.path.exists(latest) else '（尚未生成）'))


if __name__ == '__main__':
    main()
