#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把服务器上的 QQ 归档查询桥到本地。

为什么要这个桥：桌宠跑在 Windows，聊天归档在 Linux 服务器上（那边才是消息进来的地方）。
中间没有现成的通道，就用 SSH 跑一条命令把结果拿回来 —— 不装服务、不开端口，
服务器那边不用改任何东西。

用法（桌宠的工具层会调，也可以自己手动跑）：

    python tools/remote-chatlog.py --mode stats
    python tools/remote-chatlog.py --who G --limit 20
    python tools/remote-chatlog.py --q 设计稿 --from 2026-10-28
    python tools/remote-chatlog.py --mode overview

输出：一行 JSON（UTF-8）。失败也是 JSON，带 ok=false 和 reason，方便上层判断。
"""

import argparse
import json
import os
import sys

# Windows 下 stdout 默认是 GBK，中文和 emoji 会炸
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, ".data", "config.json")

# 服务器上归档工具的路径（容器内外是同一个 bind mount）
REMOTE_TOOL = "/opt/secretary/tools/qq-archive.js"
REMOTE_CONTAINER = "qqbot"


def load_server_cfg():
    """读 .data/config.json 的 server 段。没有就返回 {}，由调用方报错。"""
    try:
        with open(CONFIG, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        return {}
    return cfg.get("server") or {}


def build_remote_cmd(args):
    """拼出在服务器上执行的命令行。参数全部过一遍白名单式的转义。"""
    bits = ["node", REMOTE_TOOL]
    if args.mode == "stats":
        bits.append("--stats")
    elif args.mode == "overview":
        bits.append("--overview")
    else:
        bits.append("--json")
        for flag, val in (("--who", args.who), ("--q", args.q), ("--from", args.date_from), ("--to", args.date_to)):
            if val:
                bits.append(flag)
                bits.append(shell_quote(str(val)))
        if args.type:
            bits.append("--type")
            bits.append(args.type)
        if args.limit is not None:
            bits.append("--limit")
            bits.append(str(int(args.limit)))
        if args.me:
            bits.append("--me")
        if args.other:
            bits.append("--other")
    inner = " ".join(bits)
    return "docker exec %s %s" % (REMOTE_CONTAINER, inner)


def shell_quote(s):
    """单引号包起来，内部单引号转义。参数里不会有换行，不用担心多行。"""
    return "'" + s.replace("'", "'\\''") + "'"


def run_ssh(cfg, remote_cmd, timeout=60):
    host = cfg.get("host")
    user = cfg.get("user") or "root"
    password = cfg.get("password") or ""
    port = int(cfg.get("port") or 22)
    keyfile = cfg.get("keyFile")

    try:
        import paramiko
    except ImportError:
        return {"ok": False, "reason": "本机没有 paramiko，装一下：pip install paramiko"}

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        kw = {"hostname": host, "port": port, "username": user, "timeout": 15}
        if keyfile:
            kw["key_filename"] = keyfile
            kw["look_for_keys"] = False
        else:
            kw["password"] = password
        client.connect(**kw)
        _stdin, stdout, stderr = client.exec_command(remote_cmd, timeout=timeout)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
        if code != 0 and not out.strip():
            return {"ok": False, "reason": (err or "远端命令失败，退出码 %d" % code).strip()[:300]}
        return {"ok": True, "raw": out, "stderr": err.strip()[:300]}
    except Exception as e:
        return {"ok": False, "reason": "连不上服务器：%s" % str(e)[:200]}
    finally:
        try:
            client.close()
        except Exception:
            pass


def fmt_time(ts):
    """服务器那边已经是北京时间了，这里只做展示格式，不再加时区。"""
    import datetime
    try:
        tz = datetime.timezone(datetime.timedelta(hours=8))
        return datetime.datetime.fromtimestamp(int(ts), tz).strftime("%m-%d %H:%M")
    except Exception:
        return "?"


def render_rows(rows):
    """把归档记录排成人能读的对话。"""
    lines = []
    for r in rows:
        who = "我" if r.get("me") else (r.get("sn") or r.get("n") or "对方")
        body = r.get("x") or ("[%s]" % r.get("k") if r.get("k") and r.get("k") != "text" else "")
        lines.append("%s %s: %s" % (fmt_time(r.get("t")), who, body))
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--mode", default="list", choices=["list", "overview", "stats"])
    ap.add_argument("--who", default="")
    ap.add_argument("--q", default="")
    ap.add_argument("--from", dest="date_from", default="")
    ap.add_argument("--to", dest="date_to", default="")
    ap.add_argument("--type", default="", choices=["", "private", "group"])
    ap.add_argument("--limit", type=int, default=100)
    ap.add_argument("--me", action="store_true")
    ap.add_argument("--other", action="store_true")
    args = ap.parse_args()

    cfg = load_server_cfg()
    if not cfg.get("host"):
        print(json.dumps({
            "ok": False,
            "reason": "没配服务器地址。在 .data/config.json 里加一段 server：{host, user, password}",
        }, ensure_ascii=False))
        return 1

    cmd = build_remote_cmd(args)
    res = run_ssh(cfg, cmd)
    if not res.get("ok"):
        print(json.dumps(res, ensure_ascii=False))
        return 1

    raw = res.get("raw") or ""

    if args.mode in ("stats", "overview"):
        print(json.dumps({"ok": True, "text": raw.strip()}, ensure_ascii=False))
        return 0

    # list 模式：远端给的是 JSON 数组
    try:
        rows = json.loads(raw.strip() or "[]")
    except Exception:
        print(json.dumps({"ok": False, "reason": "远端返回的不是 JSON：%s" % raw[:200]}, ensure_ascii=False))
        return 1

    text = render_rows(rows)
    print(json.dumps({
        "ok": True,
        "count": len(rows),
        "rows": rows,
        "text": text,
        "range": ("%s ~ %s" % (fmt_time(rows[0]["t"]), fmt_time(rows[-1]["t"]))) if rows else "",
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
