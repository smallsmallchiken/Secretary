"""
企业微信服务端 API：gettoken + message/send。

access_token 有 7200 秒有效期且**同一应用的新 token 会让旧 token 失效**，
所以必须缓存；这里留 300 秒余量提前刷新，并在遇到 42001（token 过期）时
强制刷新重试一次。
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://qyapi.weixin.qq.com/cgi-bin"
TOKEN_EXPIRED = 42001
TOKEN_INVALID = 40014


class ApiError(Exception):
    def __init__(self, errcode, errmsg, where=""):
        super().__init__(f"{where} errcode={errcode} errmsg={errmsg}")
        self.errcode = errcode
        self.errmsg = errmsg
        self.where = where


class WeComApi:
    def __init__(self, corpid, corpsecret, agentid, base=BASE, timeout=20):
        self.corpid = corpid
        self.corpsecret = corpsecret
        self.agentid = int(agentid)
        self.base = (base or BASE).rstrip("/")
        self.timeout = timeout
        self._token = None
        self._token_expire = 0.0

    def _call(self, path, params=None, body=None, where=""):
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        req = urllib.request.Request(
            url, data=data,
            headers={"Content-Type": "application/json; charset=utf-8"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            raise ApiError(exc.code, exc.read()[:300].decode("utf-8", "replace"),
                           where or path) from exc
        except Exception as exc:
            raise ApiError(-1, f"{type(exc).__name__}: {exc}", where or path) from exc
        try:
            return json.loads(raw)
        except ValueError as exc:
            raise ApiError(-1, f"响应不是 JSON: {raw[:200]!r}", where or path) from exc

    def token(self, force=False):
        if not force and self._token and time.time() < self._token_expire:
            return self._token
        d = self._call("/gettoken",
                       {"corpid": self.corpid, "corpsecret": self.corpsecret},
                       where="gettoken")
        if d.get("errcode"):
            raise ApiError(d.get("errcode"), d.get("errmsg", ""), "gettoken")
        tok = d.get("access_token")
        if not tok:
            raise ApiError(-1, f"gettoken 没返回 access_token: {d}", "gettoken")
        self._token = tok
        self._token_expire = time.time() + max(60, d.get("expires_in", 7200) - 300)
        return tok

    def send_text(self, to_user, content, safe=0):
        """给成员发文本消息。返回 msgid。"""
        if not to_user:
            raise ApiError(-1, "touser 为空", "message/send")
        if not content:
            raise ApiError(-1, "内容为空", "message/send")
        body = {
            "touser": to_user,
            "msgtype": "text",
            "agentid": self.agentid,
            "text": {"content": content},
            "safe": safe,
        }
        for attempt in (1, 2):
            tok = self.token(force=(attempt == 2))
            d = self._call("/message/send", {"access_token": tok}, body,
                           where="message/send")
            code = d.get("errcode", 0)
            if code in (TOKEN_EXPIRED, TOKEN_INVALID) and attempt == 1:
                continue
            if code:
                raise ApiError(code, d.get("errmsg", ""), "message/send")
            if d.get("invaliduser"):
                raise ApiError(-1, f"以下成员不存在: {d['invaliduser']}",
                               "message/send")
            return d.get("msgid", "")
        raise ApiError(-1, "token 刷新后仍失败", "message/send")

    def whoami(self):
        """校验凭据是否可用：能拿到 token 就算通。"""
        tok = self.token(force=True)
        return {"ok": True, "token_len": len(tok),
                "expires_in": int(self._token_expire - time.time())}
