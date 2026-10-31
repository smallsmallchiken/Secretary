#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把服务器上的 QQ 归档同步到本地。

为什么要同步：桌宠每次查询都 SSH 过去要 5~6 秒（握手 + docker exec + node 启动），
聊天里等这么久体验太差。归档是每天一个 JSONL 文件、一天才几百 KB，
拉到本地之后用 src/core/qq/archive.js 直接查，毫秒级。

服务器那边是唯一写入方，这里只读，所以不用担心两边写冲突。

    python tools/sync-archive.py          # 增量同步（只拉本地没有或变大的）
    python tools/sync-archive.py --force  # 全量重拉
    python tools/sync-archive.py --quiet  # 只输出一行摘要

输出 JSON：{"ok":true,"pulled":["2026-10-31.jsonl"],"total":77}
"""

import argparse
import json
import os
import posixpath
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, ".data", "config.json")
LOCAL_DIR = os.path.join(ROOT, ".data", "archive")
REMOTE_DIR = "/opt/secretary/.data/archive"


def load_server_cfg():
    try:
        with open(CONFIG, "r", encoding="utf-8") as f:
            return (json.load(f).get("server") or {})
    except Exception:
        return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    cfg = load_server_cfg()
    if not cfg.get("host"):
        print(json.dumps({"ok": False, "reason": "没配 server 段"}, ensure_ascii=False))
        return 1

    try:
        import paramiko
    except ImportError:
        print(json.dumps({"ok": False, "reason": "缺 paramiko"}, ensure_ascii=False))
        return 1

    os.makedirs(LOCAL_DIR, exist_ok=True)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    pulled, skipped = [], 0
    try:
        kw = {"hostname": cfg.get("host"), "port": int(cfg.get("port") or 22),
              "username": cfg.get("user") or "root", "timeout": 15}
        if cfg.get("keyFile"):
            kw["key_filename"] = cfg["keyFile"]
            kw["look_for_keys"] = False
        else:
            kw["password"] = cfg.get("password") or ""
        client.connect(**kw)
        sftp = client.open_sftp()

        try:
            entries = sftp.listdir_attr(REMOTE_DIR)
        except IOError:
            print(json.dumps({"ok": True, "pulled": [], "total": 0, "note": "服务器上还没有归档"}, ensure_ascii=False))
            return 0

        for ent in entries:
            name = ent.filename
            if not name.endswith(".jsonl"):
                continue
            local = os.path.join(LOCAL_DIR, name)
            # 增量：本地已有且不小于远端就跳过（归档只追加，文件只会变大）
            if not args.force and os.path.exists(local) and os.path.getsize(local) >= ent.st_size:
                skipped += 1
                continue
            # 远端路径必须用 posixpath 拼：在 Windows 上 os.path.join 会拼出反斜杠，
            # SFTP 那边就找不到文件（踩过一次，"No such file" 但远端明明有）
            sftp.get(posixpath.join(REMOTE_DIR, name), local)
            pulled.append(name)

        sftp.close()
    except Exception as e:
        print(json.dumps({"ok": False, "reason": "同步失败：%s" % str(e)[:200]}, ensure_ascii=False))
        return 1
    finally:
        try:
            client.close()
        except Exception:
            pass

    # 数一下本地总共多少条
    total = 0
    for name in os.listdir(LOCAL_DIR):
        if not name.endswith(".jsonl"):
            continue
        try:
            with open(os.path.join(LOCAL_DIR, name), "r", encoding="utf-8", errors="replace") as f:
                total += sum(1 for line in f if line.strip())
        except Exception:
            pass

    print(json.dumps({"ok": True, "pulled": pulled, "skipped": skipped, "total": total}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
