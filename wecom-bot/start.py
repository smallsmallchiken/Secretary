"""
一键启动：本地回调服务 + 公网隧道，并打印要填进企业微信后台的回调地址。

  python start.py

Ctrl+C 一起停。
"""

import os
import re
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import server
import tunnel


def main():
    try:
        cfg = server.load_config()
    except SystemExit as exc:
        print(exc)
        return 1
    port = int(cfg["port"])

    server.build(cfg)
    from http.server import ThreadingHTTPServer
    srv = ThreadingHTTPServer(("0.0.0.0", port), server.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"回调服务已启动：http://127.0.0.1:{port}{cfg['path']}")
    if cfg.get("dryRun", True):
        print("dryRun=True：只生成回复并记日志，不真的发出去。"
              "跑通后把 config.json 的 dryRun 改成 false。")

    proc = subprocess.Popen(
        ["ssh"] + tunnel.SSH_OPTS
        + ["-p", "443", "-R", f"80:localhost:{port}", "serveo.net"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding="utf-8", errors="replace", bufsize=1)

    found = threading.Event()

    def pump():
        for line in proc.stdout:
            m = tunnel.SERVEO_RE.search(line)
            if m and not found.is_set():
                found.set()
                tunnel.announce(m.group(0), cfg["path"])
                print("配好后在企业微信里给这个应用发一条消息试试。")
                print()
            elif not found.is_set() and line.strip():
                print("  [隧道]", line.rstrip())

    threading.Thread(target=pump, daemon=True).start()

    try:
        while proc.poll() is None:
            time.sleep(0.5)
        if not found.is_set():
            print("隧道没给出公网地址，退出")
            return 1
    except KeyboardInterrupt:
        print("\n停止")
    finally:
        try:
            proc.terminate()
        except Exception:
            pass
        srv.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
