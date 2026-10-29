"""
把本地回调服务暴露到公网。企业微信要求回调地址是公网可达的 HTTPS。

**这台机器上 cloudflared 用不了**：它走 7844 端口（UDP QUIC + TCP HTTP2），
实测都被封了，precheck 直接 hard_fail：
    UDP Connectivity  region1.v2.argotunnel.com  FAIL  QUIC connection failed
    TCP Connectivity  region1.v2.argotunnel.com  FAIL  HTTP/2 blocked
     ERROR: Allow outbound QUIC traffic on port 7844 or use HTTP2.
本机还挂着代理（fake-ip 模式，198.18.x.x），只放行 443，7844 不管。

所以默认改用 **serveo.net 的 SSH 隧道走 443**（本机 22 端口被代理阻断，
443 是通的，git 也是这么走的）。实测可达。

**地址是临时的**：ssh 一断就换新的，换了要回企业微信后台改一次回调 URL。
要固定地址得在 console.serveo.net 注册一个 SSH key 并占名字（免费）。

用法：
  python tunnel.py                  # 默认 serveo，端口取 config.json 的
  python tunnel.py --port 8765
  python tunnel.py --cloudflared    # 换回 cloudflared（本机大概率失败）
"""

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CF = os.path.join(HERE, "cloudflared.exe")
SERVEO_RE = re.compile(r"https://[a-z0-9-]+\.serveousercontent\.com")
CF_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

SSH_OPTS = ["-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "ServerAliveInterval=20",
            "-o", "ExitOnForwardFailure=yes"]


def load_port():
    try:
        with open(os.path.join(HERE, "config.json"), encoding="utf-8") as f:
            return int((json.load(f) or {}).get("port", 8765))
    except Exception:
        return 8765


def announce(url, path):
    print()
    print("=" * 74)
    print("回调地址（填进企业微信后台「应用 → 接收消息 → API 接收消息」的 URL）：")
    print(f"  {url}{path}")
    print("=" * 74)
    print()
    print("顺序很重要：先让本地服务跑起来（python server.py serve），")
    print("再把这个地址填进后台点保存 —— 企业微信会立刻发一次 GET 验证，")
    print("服务不在线就验证不过。")
    print()
    print("Ctrl+C 结束隧道。地址是临时的，断了就换新的，要回后台改一次。")
    print()


def run_serveo(port, path):
    cmd = ["ssh"] + SSH_OPTS + ["-p", "443", "-R", f"80:localhost:{port}",
                                "serveo.net"]
    print(f"启动 serveo 隧道（ssh 443）-> http://127.0.0.1:{port}")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True,
                            encoding="utf-8", errors="replace", bufsize=1)
    return proc, SERVEO_RE, ("提示：免费版浏览器访问会看到一个警告页，"
                             "但企业微信的回调是普通 HTTP 客户端，不受影响。")


def run_cloudflared(port, path):
    if not os.path.exists(CF):
        print(f"没找到 {CF}")
        return None, None, ""
    print(f"启动 cloudflared 隧道 -> http://127.0.0.1:{port}")
    proc = subprocess.Popen(
        [CF, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding="utf-8", errors="replace", bufsize=1)
    return proc, CF_RE, ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--path", default="/callback")
    ap.add_argument("--cloudflared", action="store_true")
    args = ap.parse_args()

    port = args.port or load_port()
    proc, pat, note = (run_cloudflared(port, args.path) if args.cloudflared
                       else run_serveo(port, args.path))
    if proc is None:
        return 1

    found = threading.Event()

    def pump():
        for line in proc.stdout:
            line = line.rstrip()
            m = pat.search(line)
            if m and not found.is_set():
                found.set()
                announce(m.group(0), args.path)
                if note:
                    print(note)
                    print()
            elif not found.is_set() and line.strip():
                print("  [隧道]", line)

    t = threading.Thread(target=pump, daemon=True)
    t.start()

    try:
        while proc.poll() is None:
            time.sleep(0.5)
        if not found.is_set():
            print(f"隧道进程退出（返回码 {proc.poll()}），没拿到公网地址")
            return 1
    except KeyboardInterrupt:
        print("\n结束隧道")
    finally:
        try:
            proc.terminate()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
