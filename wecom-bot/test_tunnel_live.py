"""
真·端到端验证：本地回调服务 + 公网隧道 + 模拟企业微信的请求。

这一步验的是**只有真跑起来才知道的东西**：公网地址能不能被外面访问到、
企业微信那种普通 HTTP 客户端会不会被隧道的警告页拦住、签名在真实
URL 编解码往返之后还对不对。

需要联网，也需要本地服务与隧道都已经起来：
  终端1：python server.py serve
  终端2：python tunnel.py
  终端3：python test_tunnel_live.py https://xxx.serveousercontent.com

不做这一步的后果：地址填进后台点保存，企业微信发 GET 验证失败，
你在后台只看到一句「验证失败」，不知道是签名错、服务没起、还是隧道没通。
"""

import os
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import crypto
import server

FAIL = []


def check(name, got, want):
    ok = got == want
    print(f"  {'ok  ' if ok else 'FAIL'} {name}: {got!r}" +
          ("" if ok else f"（期望 {want!r}）"))
    if not ok:
        FAIL.append(name)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "WeCom-Callback/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except Exception as exc:
        return -1, f"{type(exc).__name__}: {exc}"


def main():
    if len(sys.argv) < 2:
        print("用法：python test_tunnel_live.py https://xxx.serveousercontent.com")
        return 1
    base = sys.argv[1].rstrip("/")
    cfg = server.load_config()
    crypt = crypto.WeComCrypto(cfg["token"], cfg["encodingAESKey"], cfg["corpid"])
    path = cfg["path"]
    print(f"公网地址 {base}{path}")

    print("\n[1] 带正确签名的 URL 验证（企业微信后台点保存时发的就是这个）")
    echo_plain = "1616140317555161061"
    echo = crypt.encrypt(echo_plain)
    ts, nonce = "1700000000", "testnonce"
    sig = crypt.signature(ts, nonce, echo)
    q = urllib.parse.urlencode({"msg_signature": sig, "timestamp": ts,
                                "nonce": nonce, "echostr": echo})
    code, body = fetch(f"{base}{path}?{q}")
    check("状态码", code, 200)
    check("返回的就是明文（不能带引号/BOM/换行）", body, echo_plain)

    print("\n[2] 签名错的请求必须被拒")
    bad = urllib.parse.urlencode({"msg_signature": "0" * 40, "timestamp": ts,
                                  "nonce": nonce, "echostr": echo})
    code, _ = fetch(f"{base}{path}?{bad}")
    check("状态码", code, 403)

    print("\n[3] 本地 /health 直连（对照，确认不是隧道在骗人）")
    code, body = fetch(f"http://127.0.0.1:{cfg['port']}/health")
    check("状态码", code, 200)

    print()
    if FAIL:
        print(f"{len(FAIL)} 项未通过: {FAIL}")
        print("重点看第 [1] 项：它不通，后台就一定保存不了。")
        return 1
    print("端到端通了。可以把地址填进企业微信后台了。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
