"""
回调加解密层的离线断言。不联网。

其中 AES-256-CBC 那一项用 **NIST SP 800-38A 的公开测试向量**（F.2.5）验证，
这是唯一能拿外部权威数据校准的部分 —— 自研的加解密最怕"自己加密自己解密
都对、跟腾讯一对就错"。块长 32 的 PKCS7 和企业微信特有的明文结构没有公开
向量，只能靠结构断言，所以那两项测的是长度和边界，不是数值。
"""

import base64
import hashlib
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

import crypto

FAIL = []


def check(name, got, want):
    ok = got == want
    print(f"  {'ok  ' if ok else 'FAIL'} {name}: {got!r}" +
          ("" if ok else f"（期望 {want!r}）"))
    if not ok:
        FAIL.append(name)


def check_true(name, got):
    check(name, bool(got), True)


def raises(name, fn):
    try:
        fn()
    except crypto.WeComCryptoError:
        print(f"  ok   {name}: 按预期报错")
        return
    except Exception as exc:
        print(f"  FAIL {name}: 抛了别的异常 {type(exc).__name__}: {exc}")
        FAIL.append(name)
        return
    print(f"  FAIL {name}: 没报错")
    FAIL.append(name)


def new_key():
    return base64.b64encode(os.urandom(32)).decode("ascii")[:43]


CORPID = "ww1234567890abcdef"
TOKEN = "myToken123"


def main():
    print("AES-256-CBC 用法：NIST SP 800-38A F.2.5 公开测试向量")
    key = bytes.fromhex(
        "603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4")
    iv = bytes.fromhex("000102030405060708090a0b0c0d0e0f")
    pt = bytes.fromhex("6bc1bee22e409f96e93d7e117393172a")
    want = "f58c4c04d6e5f1ba779eabfb5f7bfbd6"
    enc = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    check("AES-256-CBC 第一块密文", (enc.update(pt) + enc.finalize()).hex(), want)
    dec = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    check("反向解密回原文", (dec.update(bytes.fromhex(want))
                            + dec.finalize()).hex(), pt.hex())

    print("\n构造校验")
    raises("EncodingAESKey 不是 43 字符 -> 报错",
           lambda: crypto.WeComCrypto(TOKEN, "short", CORPID))
    raises("Token 为空 -> 报错",
           lambda: crypto.WeComCrypto("", new_key(), CORPID))
    raises("corpid 为空 -> 报错",
           lambda: crypto.WeComCrypto(TOKEN, new_key(), ""))

    print("\nPKCS7（块长 32，不是 AES 默认的 16）")
    check("整块边界补满一整块", len(crypto.pkcs7_pad(b"x" * 32)), 64)
    check("差 1 字节补 1", len(crypto.pkcs7_pad(b"x" * 31)), 32)
    check("空数据补一整块", len(crypto.pkcs7_pad(b"")), 32)
    check("补了能还原", crypto.pkcs7_unpad(crypto.pkcs7_pad(b"hello")), b"hello")
    check("补了能还原（整块）",
          crypto.pkcs7_unpad(crypto.pkcs7_pad(b"y" * 32)), b"y" * 32)
    raises("空数据去填充 -> 报错", lambda: crypto.pkcs7_unpad(b""))
    raises("填充字节超范围 -> 报错", lambda: crypto.pkcs7_unpad(b"abc" + bytes([99])))
    raises("填充内容不一致 -> 报错",
           lambda: crypto.pkcs7_unpad(b"abcdef" + bytes([3, 3, 2])))

    print("\n加解密往返")
    c = crypto.WeComCrypto(TOKEN, new_key(), CORPID)
    for msg in ["你好", "hi", "", "a" * 500, "带 emoji 🐶 和换行\n第二行",
                '<?xml version="1.0"?><xml><Content>测试</Content></xml>']:
        check(f"往返 {msg[:14]!r}（{len(msg)} 字）", c.decrypt(c.encrypt(msg)), msg)

    print("\n密文长度结构：明文 = random(16) + len(4) + msg + receiveid，再补到 32 倍数")
    for n in (0, 1, 10, 31, 32, 33, 100):
        msg = "字" * n
        raw = base64.b64decode(c.encrypt(msg))
        body_len = 16 + 4 + len(msg.encode()) + len(CORPID)
        want = (body_len + 31) // 32 * 32
        check(f"{n} 字消息 -> 密文 {want} 字节", len(raw), want)

    print("\n签名：四个串字典序排序后拼接再 sha1")
    ts, nonce, enc_b64 = "1700000000", "abc123", c.encrypt("hi")
    parts = sorted([TOKEN, ts, nonce, enc_b64])
    want_sig = hashlib.sha1("".join(parts).encode("utf-8")).hexdigest()
    check("签名与手工计算一致", c.signature(ts, nonce, enc_b64), want_sig)
    check_true("验签通过", c.verify(want_sig, ts, nonce, enc_b64))
    check("改一位就不过", c.verify(want_sig[:-1] + "0", ts, nonce, enc_b64), False)
    check("换 nonce 就不过", c.verify(want_sig, ts, "other", enc_b64), False)
    check("空签名不过", c.verify("", ts, nonce, enc_b64), False)

    print("\n拒绝伪造：receiveid 必须等于自己的 corpid")
    other = crypto.WeComCrypto(TOKEN, new_key(), "wwOTHERcorp")
    # 用另一套密钥加密的消息，本企业不该能解
    raises("别家的密钥加密 -> 解不开", lambda: c.decrypt(other.encrypt("hi")))
    # 同一密钥但 receiveid 不对 -> 必须被校验拦下
    same_key = base64.b64encode(c.key).decode("ascii")[:43]
    forged = crypto.WeComCrypto(TOKEN, same_key, "wwOTHERcorp")
    raises("receiveid 不是自己的 -> 拦下", lambda: c.decrypt(forged.encrypt("hi")))

    print("\n畸形密文")
    raises("不是 base64", lambda: c.decrypt("!!!not base64!!!"))
    raises("长度不是 16 倍数", lambda: c.decrypt(base64.b64encode(b"x" * 17).decode()))
    raises("空密文", lambda: c.decrypt(""))

    print()
    if FAIL:
        print(f"{len(FAIL)} 项未通过: {FAIL}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
