"""
消息层 + 回调服务器的离线断言。不联网、不发真消息。

服务器那一组是真起一个 HTTP 服务，用本模块自己加密出企业微信会发的那两种
请求（GET 验证 / POST 收消息），走完整条链路。这能验出路由、验签、立即应答、
去重这些**逻辑**问题；加解密本身由 test_crypto.py 用 NIST 公开向量校准。

模型调用被替换成桩函数，所以整组测试离线可跑。
"""

import base64
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import crypto
import llm
import message
import server

FAIL = []

CORPID = "wwTESTcorpid123456"
TOKEN = "testtoken"
AESKEY = base64.b64encode(b"0" * 32).decode("ascii")[:43]


def check(name, got, want):
    ok = got == want
    print(f"  {'ok  ' if ok else 'FAIL'} {name}: {got!r}" +
          ("" if ok else f"（期望 {want!r}）"))
    if not ok:
        FAIL.append(name)


def check_true(name, got):
    check(name, bool(got), True)


def test_message():
    print("消息解析：CDATA 与实体")
    xml = ("<xml><ToUserName><![CDATA[wwcorp]]></ToUserName>"
           "<FromUserName><![CDATA[zhangsan]]></FromUserName>"
           "<CreateTime>1348831860</CreateTime>"
           "<MsgType><![CDATA[text]]></MsgType>"
           "<Content><![CDATA[你好 & 再见]]></Content>"
           "<MsgId>1234567890123456</MsgId>"
           "<AgentID>1</AgentID></xml>")
    m = message.parse_message(xml)
    check("FromUserName", m["FromUserName"], "zhangsan")
    check("Content 保留 & 号", m["Content"], "你好 & 再见")
    check("MsgType", m["MsgType"], "text")
    check("取文本内容", message.text_content(m), "你好 & 再见")

    print("\n消息解析：实体转义（非 CDATA）")
    m2 = message.parse_message(
        "<xml><MsgType>text</MsgType><Content>&lt;a&gt;&amp;b</Content></xml>")
    check("实体被还原", m2["Content"], "<a>&b")

    print("\n消息解析：畸形输入必须报错，不能静默返回半截")
    for bad, desc in [(None, "None"), ("", "空串"), ("   ", "空白"),
                      ("<xml>", "残缺 XML"),
                      ("<xml><ToUserName>x</ToUserName></xml>", "没有 MsgType")]:
        try:
            message.parse_message(bad)
            print(f"  FAIL 畸形输入({desc}) 没报错")
            FAIL.append(f"畸形输入 {desc}")
        except message.MessageError:
            print(f"  ok   畸形输入({desc}) -> 报错")

    print("\n非文本消息不当成文本处理")
    m3 = message.parse_message(
        "<xml><MsgType>image</MsgType><PicUrl>x</PicUrl></xml>")
    check("image 的 text_content 是 None", message.text_content(m3), None)
    check_true("describe 能出一行摘要", message.describe(m3))

    print("\nCDATA 注入：内容里带 ]]> 不能破坏 XML")
    tricky = "a]]>b<c>"
    check("escape_cdata 拆开 ]]>", message.escape_cdata(tricky),
          "a]]]]><![CDATA[>b<c>")
    reply = message.build_reply_xml("zhangsan", CORPID, tricky, timestamp=100)
    m4 = message.parse_message(reply)
    check("拼进去还能原样解回来", m4["Content"], tricky)

    print("\n被动回复：收/发件人对调，时间用当前时间")
    r = message.build_reply_xml("zhangsan", CORPID, "好的", timestamp=1700000000)
    m5 = message.parse_message(r)
    check("ToUserName 是发消息的人", m5["ToUserName"], "zhangsan")
    check("FromUserName 是本企业", m5["FromUserName"], CORPID)
    check("CreateTime", m5["CreateTime"], "1700000000")
    check("MsgType", m5["MsgType"], "text")
    check("Content", m5["Content"], "好的")


def _get(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def _post(url, body):
    req = urllib.request.Request(url, data=body.encode("utf-8"),
                                 headers={"Content-Type": "text/xml"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def test_server():
    print("\n回调服务器：真起一个服务，模拟企业微信的两种请求")
    cfg = dict(server.DEFAULTS)
    cfg.update({"corpid": CORPID, "agentid": "1", "corpsecret": "x",
                "token": TOKEN, "encodingAESKey": AESKEY, "port": 8791,
                "path": "/callback", "dryRun": True,
                "perUserIntervalSeconds": 5, "maxPerHour": 60})
    server.build(cfg)
    from http.server import ThreadingHTTPServer
    srv = ThreadingHTTPServer(("127.0.0.1", cfg["port"]), server.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    time.sleep(0.4)
    base = f"http://127.0.0.1:{cfg['port']}{cfg['path']}"
    crypt = crypto.WeComCrypto(TOKEN, AESKEY, CORPID)

    # 模型换成桩，测试离线跑
    calls = []
    real_generate = llm.generate

    def stub(incoming, system=None, cfg=None, **kw):
        calls.append(incoming)
        return "收到：" + incoming, ""

    llm.generate = stub
    try:
        print("\n  URL 验证（GET）")
        echo = crypt.encrypt("random_echo_12345")
        ts, nonce = "1700000000", "n1"
        sig = crypt.signature(ts, nonce, echo)
        q = urllib.parse.urlencode({"msg_signature": sig, "timestamp": ts,
                                    "nonce": nonce, "echostr": echo})
        code, body = _get(f"{base}?{q}")
        check("状态码", code, 200)
        check("返回的明文", body, "random_echo_12345")

        code, _ = _get(f"{base}?msg_signature=bad&timestamp={ts}&nonce={nonce}&echostr={echo}")
        check("签名错 -> 403", code, 403)

        code, _ = _get(f"{base}?msg_signature={sig}&timestamp={ts}&nonce={nonce}")
        check("缺 echostr -> 400", code, 400)

        print("\n  收消息（POST）")
        inner = ("<xml><ToUserName><![CDATA[%s]]></ToUserName>"
                 "<FromUserName><![CDATA[zhangsan]]></FromUserName>"
                 "<CreateTime>1700000000</CreateTime>"
                 "<MsgType><![CDATA[text]]></MsgType>"
                 "<Content><![CDATA[今天开会吗]]></Content>"
                 "<MsgId>MSGID-1</MsgId><AgentID>1</AgentID></xml>" % CORPID)
        enc = crypt.encrypt(inner)
        ts2, nonce2 = "1700000001", "n2"
        sig2 = crypt.signature(ts2, nonce2, enc)
        envelope = f"<xml><ToUserName><![CDATA[{CORPID}]]></ToUserName><Encrypt><![CDATA[{enc}]]></Encrypt></xml>"
        url2 = f"{base}?{urllib.parse.urlencode({'msg_signature': sig2, 'timestamp': ts2, 'nonce': nonce2})}"

        t0 = time.time()
        code, body = _post(url2, envelope)
        elapsed = time.time() - t0
        check("状态码", code, 200)
        check("立即应答（空 body，交给后台处理）", body, "")
        check_true(f"应答耗时 {elapsed:.2f}s 远小于 5 秒上限", elapsed < 2.0)
        time.sleep(0.8)
        check("模型被调了一次", len(calls), 1)
        check("传给模型的是消息内容", calls[0], "今天开会吗")

        print("\n  重试去重（企业微信会重发同一条）")
        _post(url2, envelope)
        time.sleep(0.6)
        check("同 MsgId 不再处理", len(calls), 1)

        print("\n  新消息仍要处理")
        inner2 = inner.replace("MSGID-1", "MSGID-2").replace("今天开会吗", "在吗")
        enc2 = crypt.encrypt(inner2)
        sig3 = crypt.signature(ts2, nonce2, enc2)
        env2 = f"<xml><ToUserName><![CDATA[{CORPID}]]></ToUserName><Encrypt><![CDATA[{enc2}]]></Encrypt></xml>"
        _post(f"{base}?{urllib.parse.urlencode({'msg_signature': sig3, 'timestamp': ts2, 'nonce': nonce2})}", env2)
        time.sleep(0.8)
        check("新 MsgId 会处理", len(calls), 2)
        check("内容是新的", calls[1], "在吗")

        print("\n  非文本消息跳过")
        inner3 = ("<xml><ToUserName><![CDATA[%s]]></ToUserName>"
                  "<FromUserName><![CDATA[zhangsan]]></FromUserName>"
                  "<MsgType><![CDATA[image]]></MsgType>"
                  "<MsgId>MSGID-3</MsgId><AgentID>1</AgentID></xml>" % CORPID)
        enc3 = crypt.encrypt(inner3)
        sig4 = crypt.signature(ts2, nonce2, enc3)
        env3 = f"<xml><Encrypt><![CDATA[{enc3}]]></Encrypt></xml>"
        _post(f"{base}?{urllib.parse.urlencode({'msg_signature': sig4, 'timestamp': ts2, 'nonce': nonce2})}", env3)
        time.sleep(0.8)
        check("图片消息不调模型", len(calls), 2)

        print("\n  伪造请求")
        code, _ = _post(f"{base}?msg_signature=bad&timestamp={ts2}&nonce={nonce2}", envelope)
        check("POST 签名错 -> 403", code, 403)
        # 签名对但密文本身非法：这时才轮到解密失败，应当是 400 而不是 403
        bad_enc = "notbase64"
        sig5 = crypt.signature(ts2, nonce2, bad_enc)
        code, _ = _post(
            f"{base}?{urllib.parse.urlencode({'msg_signature': sig5, 'timestamp': ts2, 'nonce': nonce2})}",
            f"<xml><Encrypt><![CDATA[{bad_enc}]]></Encrypt></xml>")
        check("签名对但密文非法 -> 400", code, 400)
        code, _ = _post(f"{base}?msg_signature=bad&timestamp={ts2}&nonce={nonce2}",
                        "<xml><ToUserName>x</ToUserName></xml>")
        check("信封里没有 Encrypt -> 400", code, 400)
        code, _ = _get(f"http://127.0.0.1:{cfg['port']}/health")
        check("/health 可用", code, 200)
    finally:
        llm.generate = real_generate
        srv.shutdown()


def main():
    test_message()
    test_server()
    print()
    if FAIL:
        print(f"{len(FAIL)} 项未通过: {FAIL}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
