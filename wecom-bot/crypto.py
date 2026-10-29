"""
企业微信回调消息加解密（官方 WXBizMsgCrypt 规范）。

协议要点：
  - AES-256-CBC，密钥 = base64decode(EncodingAESKey + "=")（43 字符 -> 32 字节），
    IV 取密钥前 16 字节
  - 填充用 PKCS7，但**块长是 32 不是 16**（企业微信自己改的，照 AES 默认写会解不开）
  - 明文结构 = random(16) + msg_len(4, 大端) + msg + receiveid
  - 签名 = sha1(把 token/timestamp/nonce/encrypt 四个串**字典序排序后**直接拼起来)

receiveid 必须校验：它是 corpid（或第三方平台的 suiteid）。不校验的话，
别人拿自己企业的密钥加密的消息也能通过验签，等于没有认证。
"""

import base64
import hashlib
import hmac
import os
import struct

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

BLOCK_SIZE = 32
RANDOM_LEN = 16
HEADER_LEN = 20  # random(16) + msg_len(4)


class WeComCryptoError(Exception):
    pass


def pkcs7_pad(data, block=BLOCK_SIZE):
    pad = block - (len(data) % block)
    return data + bytes([pad]) * pad


def pkcs7_unpad(data, block=BLOCK_SIZE):
    if not data:
        raise WeComCryptoError("空数据")
    pad = data[-1]
    if pad < 1 or pad > block or pad > len(data):
        raise WeComCryptoError(f"padding 长度非法: {pad}")
    if data[-pad:] != bytes([pad]) * pad:
        raise WeComCryptoError("padding 内容不一致")
    return data[:-pad]


class WeComCrypto:
    def __init__(self, token, encoding_aes_key, receive_id):
        if not token:
            raise WeComCryptoError("Token 为空")
        if len(encoding_aes_key) != 43:
            raise WeComCryptoError(
                f"EncodingAESKey 必须是 43 个字符，现在是 {len(encoding_aes_key)}")
        self.token = token
        self.key = base64.b64decode(encoding_aes_key + "=")
        if len(self.key) != 32:
            raise WeComCryptoError(
                f"AESKey 解出来是 {len(self.key)} 字节，应当是 32")
        if not receive_id:
            raise WeComCryptoError("receive_id（corpid）为空")
        self.receive_id = receive_id

    def _cipher(self):
        return Cipher(algorithms.AES(self.key), modes.CBC(self.key[:16]))

    def signature(self, timestamp, nonce, encrypt):
        parts = sorted([self.token, str(timestamp), str(nonce), encrypt])
        return hashlib.sha1("".join(parts).encode("utf-8")).hexdigest()

    def verify(self, signature, timestamp, nonce, encrypt):
        if not signature:
            return False
        return hmac.compare_digest(
            self.signature(timestamp, nonce, encrypt), signature)

    def encrypt(self, plaintext):
        msg = plaintext.encode("utf-8")
        body = (os.urandom(RANDOM_LEN)
                + struct.pack("!I", len(msg))
                + msg
                + self.receive_id.encode("utf-8"))
        enc = self._cipher().encryptor()
        out = enc.update(pkcs7_pad(body)) + enc.finalize()
        return base64.b64encode(out).decode("ascii")

    def decrypt(self, encrypt_b64):
        try:
            raw = base64.b64decode(encrypt_b64, validate=True)
        except Exception as exc:
            raise WeComCryptoError(f"base64 解不开: {exc}") from exc
        if not raw or len(raw) % 16 != 0:
            raise WeComCryptoError(f"密文长度 {len(raw)} 不是 16 的倍数")
        dec = self._cipher().decryptor()
        try:
            body = pkcs7_unpad(dec.update(raw) + dec.finalize())
        except WeComCryptoError:
            raise
        except Exception as exc:
            raise WeComCryptoError(f"解密失败（密钥可能不对）: {exc}") from exc
        if len(body) < HEADER_LEN:
            raise WeComCryptoError(f"明文只有 {len(body)} 字节，短于 {HEADER_LEN}")
        msg_len = struct.unpack("!I", body[16:20])[0]
        if msg_len < 0 or HEADER_LEN + msg_len > len(body):
            raise WeComCryptoError(f"msg_len={msg_len} 超出明文长度 {len(body)}")
        msg = body[HEADER_LEN:HEADER_LEN + msg_len]
        recv = body[HEADER_LEN + msg_len:].decode("utf-8", "replace")
        if recv != self.receive_id:
            raise WeComCryptoError(
                f"receiveid 不符：消息里是 {recv!r}，期望 {self.receive_id!r}")
        try:
            return msg.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise WeComCryptoError(f"消息不是合法 UTF-8: {exc}") from exc
