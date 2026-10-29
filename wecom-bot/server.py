"""
企业微信回调服务器：URL 验证 + 收消息 + 自动回复。

官方要求（接收消息与事件文档）：
  - URL 验证：GET ?msg_signature&timestamp&nonce&echostr，**1 秒内**返回明文，
    不能带引号、不能带 BOM、不能带换行
  - 收消息：POST ?msg_signature&timestamp&nonce，body 是 <xml><Encrypt>…</Encrypt></xml>
  - **5 秒内不响应会断连接并重试 3 次**，官方建议「接受回调后立即应答，业务异步处理」

所以这里：解密 + 校验 + 去重之后**立刻回空串**，生成和发送放到后台线程。
不这样做的话，模型思考的几秒钟会让企业微信超时重试，同一条消息被回多遍。

用法：
  python server.py check          # 只校验凭据能不能拿到 token
  python server.py serve          # 起服务
  python server.py send 用户ID 内容   # 手动发一条，验证发送链路
"""

import argparse
import json
import os
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import api
import crypto
import llm
import message

CONFIG_PATH = os.path.join(HERE, "config.json")
LOG_PATH = os.path.join(HERE, "wecom.log")

DEFAULTS = {
    "corpid": "",
    "agentid": "",
    "corpsecret": "",
    "token": "",
    "encodingAESKey": "",
    "port": 8765,
    "path": "/callback",
    "systemPrompt": "",
    "perUserIntervalSeconds": 5,
    "maxPerHour": 60,
    "dryRun": True,
}


def load_config(path=None):
    path = path or CONFIG_PATH
    if not os.path.exists(path):
        raise SystemExit(f"缺少配置文件 {path}\n"
                         f"照着 config.example.json 填一份（不要提交到仓库）")
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    out = dict(DEFAULTS)
    out.update(cfg)
    missing = [k for k in ("corpid", "agentid", "corpsecret", "token",
                           "encodingAESKey") if not out.get(k)]
    if missing:
        raise SystemExit(f"配置缺这几项：{missing}")
    return out


def log(*parts):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} " + " ".join(str(p) for p in parts)
    print(line, flush=True)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


class State:
    """去重与限流。"""

    def __init__(self, cfg):
        self.cfg = cfg
        self.seen = {}          # MsgId -> 处理时间
        self.last_by_user = {}  # UserID -> 上次回复时间
        self.hour = []          # 回复时间戳
        self.lock = threading.Lock()

    def seen_before(self, msgid):
        if not msgid:
            return False
        with self.lock:
            now = time.time()
            self.seen = {k: v for k, v in self.seen.items() if now - v < 3600}
            if msgid in self.seen:
                return True
            self.seen[msgid] = now
            return False

    def allow(self, user):
        now = time.time()
        with self.lock:
            self.hour = [t for t in self.hour if now - t < 3600]
            if len(self.hour) >= self.cfg["maxPerHour"]:
                return False, f"每小时上限 {self.cfg['maxPerHour']}"
            gap = now - self.last_by_user.get(user, 0)
            need = self.cfg["perUserIntervalSeconds"]
            if gap < need:
                return False, f"同一个人间隔 {gap:.0f}s < {need}s"
            return True, ""

    def record(self, user):
        now = time.time()
        with self.lock:
            self.last_by_user[user] = now
            self.hour.append(now)


class Handler(BaseHTTPRequestHandler):
    server_version = "WeComBot/1.0"
    cfg = None
    crypt = None
    api = None
    state = None

    def log_message(self, fmt, *args):
        pass

    def _respond(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)
        except Exception as exc:
            log("[WARN] 写响应失败:", exc)

    def _params(self):
        _, _, query = self.path.partition("?")
        return urllib.parse.parse_qs(query)

    def _path_ok(self):
        p = self.path.partition("?")[0].rstrip("/") or "/"
        want = (self.cfg["path"] or "/callback").rstrip("/") or "/"
        return p == want

    def do_GET(self):
        if self.path.partition("?")[0] == "/health":
            self._respond(200, b"ok")
            return
        if not self._path_ok():
            self._respond(404, b"not found")
            return
        p = self._params()
        sig = (p.get("msg_signature") or [""])[0]
        ts = (p.get("timestamp") or [""])[0]
        nonce = (p.get("nonce") or [""])[0]
        echo = (p.get("echostr") or [""])[0]
        if not echo:
            self._respond(400, b"missing echostr")
            return
        if not self.crypt.verify(sig, ts, nonce, echo):
            log("[URL验证] 验签失败 sig=%s ts=%s nonce=%s" % (sig[:8], ts, nonce))
            self._respond(403, b"signature mismatch")
            return
        try:
            plain = self.crypt.decrypt(echo)
        except crypto.WeComCryptoError as exc:
            log("[URL验证] 解密失败:", exc)
            self._respond(400, f"decrypt failed: {exc}".encode("utf-8"))
            return
        log(f"[URL验证] 通过，返回明文 {plain!r}")
        # 明文必须原样返回：不加引号、不带 BOM、不带换行
        self._respond(200, plain.encode("utf-8"))

    def do_POST(self):
        if not self._path_ok():
            self._respond(404, b"not found")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        body = self.rfile.read(length).decode("utf-8", "replace")
        p = self._params()
        sig = (p.get("msg_signature") or [""])[0]
        ts = (p.get("timestamp") or [""])[0]
        nonce = (p.get("nonce") or [""])[0]
        try:
            env = message.parse_envelope(body)
        except message.MessageError as exc:
            log("[收消息] 信封解析失败:", exc, body[:200])
            self._respond(400, b"bad envelope")
            return
        if not self.crypt.verify(sig, ts, nonce, env["Encrypt"]):
            log("[收消息] 验签失败")
            self._respond(403, b"signature mismatch")
            return
        try:
            plain = self.crypt.decrypt(env["Encrypt"])
            msg = message.parse_message(plain)
        except (crypto.WeComCryptoError, message.MessageError) as exc:
            log("[收消息] 解密/解析失败:", exc)
            self._respond(400, b"decrypt failed")
            return

        # 先应答再处理：官方要求 5 秒内响应，否则重试 3 次会重复回消息
        self._respond(200, b"")
        threading.Thread(target=self.handle_message, args=(msg,),
                         daemon=True).start()

    def handle_message(self, msg):
        try:
            log("[收到]", message.describe(msg))
            if self.state.seen_before(msg.get("MsgId")):
                log("  [跳过] 这条 MsgId 处理过了（企业微信重试）")
                return
            content = message.text_content(msg)
            if content is None:
                log(f"  [跳过] 只处理文本消息，这条是 {msg.get('MsgType')}")
                return
            user = msg.get("FromUserName") or ""
            if not user:
                log("  [跳过] 没有 FromUserName")
                return
            ok, why = self.state.allow(user)
            if not ok:
                log(f"  [跳过] 限流：{why}")
                return
            reply, err = llm.generate(
                content, system=self.cfg.get("systemPrompt") or None)
            if not reply:
                log(f"  [失败] 生成不出回复：{err}")
                return
            if self.cfg.get("dryRun", True):
                log(f"  [dry-run] 不回：{reply!r}")
                return
            self.api.send_text(user, reply)
            self.state.record(user)
            log(f"  [已回] {user} <- {reply!r}")
        except api.ApiError as exc:
            log(f"  [失败] 发送出错：{exc}")
        except Exception as exc:
            log(f"  [异常] {type(exc).__name__}: {exc}")


def build(cfg):
    Handler.cfg = cfg
    Handler.crypt = crypto.WeComCrypto(cfg["token"], cfg["encodingAESKey"],
                                       cfg["corpid"])
    Handler.api = api.WeComApi(cfg["corpid"], cfg["corpsecret"], cfg["agentid"])
    Handler.state = State(cfg)
    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["serve", "check", "send", "signature"])
    ap.add_argument("args", nargs="*")
    args = ap.parse_args()

    cfg = load_config()
    crypt = crypto.WeComCrypto(cfg["token"], cfg["encodingAESKey"], cfg["corpid"])
    client = api.WeComApi(cfg["corpid"], cfg["corpsecret"], cfg["agentid"])

    if args.cmd == "check":
        info = client.whoami()
        print(f"corpid={cfg['corpid']} agentid={cfg['agentid']}")
        print(f"凭据可用，token 长度 {info['token_len']}，"
              f"约 {info['expires_in']} 秒后过期")
        print(f"回调加解密配置就绪（EncodingAESKey 43 字符、corpid 非空）")
        print(f"dryRun={cfg.get('dryRun')}（true 时只生成不发送）")
        return 0

    if args.cmd == "send":
        if len(args.args) < 2:
            print("用法：python server.py send 用户ID 内容")
            return 1
        mid = client.send_text(args.args[0], " ".join(args.args[1:]))
        print(f"已发送，msgid={mid}")
        return 0

    if args.cmd == "signature":
        # 手工算一次签名，用来跟官方「接口调试工具」对拍
        if len(args.args) < 3:
            print("用法：python server.py signature 密文 timestamp nonce")
            return 1
        print(crypt.signature(args.args[1], args.args[2], args.args[0]))
        return 0

    build(cfg)
    port = int(cfg["port"])
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    log(f"回调服务已启动：http://127.0.0.1:{port}{cfg['path']}")
    log(f"dryRun={cfg.get('dryRun')}"
        + ("（只生成不发送，改 config.json 关掉）" if cfg.get("dryRun") else ""))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("退出")
    return 0


if __name__ == "__main__":
    sys.exit(main())
