"""
企业微信回调消息的解析与构造。纯逻辑，可离线测。

收消息 XML（Encrypt 解密后的明文）：
    <xml>
      <ToUserName><![CDATA[CorpID]]></ToUserName>
      <FromUserName><![CDATA[成员UserID]]></FromUserName>
      <CreateTime>1348831860</CreateTime>
      <MsgType><![CDATA[text]]></MsgType>
      <Content><![CDATA[消息内容]]></Content>
      <MsgId>1234567890123456</MsgId>
      <AgentID>1</AgentID>
    </xml>

被动回复 XML（要再加密后包进 <xml><Encrypt>…</Encrypt></xml>）：
    ToUserName / FromUserName 与收到的消息**对调**，CreateTime 用当前时间。
"""

import time
import xml.etree.ElementTree as ET


class MessageError(Exception):
    pass


def escape_cdata(s):
    """CDATA 里不能出现 ]]>，出现就拆成两段 CDATA。"""
    return (s or "").replace("]]>", "]]]]><![CDATA[>")


def _parse(xml_text):
    if not xml_text or not xml_text.strip():
        raise MessageError("XML 为空")
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise MessageError(f"XML 解析失败: {exc}") from exc
    return {child.tag: (child.text or "") for child in root}


def parse_envelope(xml_text):
    """解析 POST body 的外层信封，取 Encrypt / ToUserName / AgentID。"""
    d = _parse(xml_text)
    if not d.get("Encrypt"):
        raise MessageError(f"信封里没有 Encrypt 字段：{sorted(d)}")
    return d


def parse_message(xml_text):
    """解析解密后的消息明文。"""
    d = _parse(xml_text)
    if not d.get("MsgType"):
        raise MessageError(f"消息里没有 MsgType：{sorted(d)}")
    return d


def build_reply_xml(to_user, from_user, content, timestamp=None):
    """构造被动回复的明文 XML。

    注意 to/from 是对调：回复的 ToUserName 是发消息的人，
    FromUserName 是本企业的 CorpID。
    """
    ts = int(time.time() if timestamp is None else timestamp)
    return (
        "<xml>"
        f"<ToUserName><![CDATA[{escape_cdata(to_user)}]]></ToUserName>"
        f"<FromUserName><![CDATA[{escape_cdata(from_user)}]]></FromUserName>"
        f"<CreateTime>{ts}</CreateTime>"
        "<MsgType><![CDATA[text]]></MsgType>"
        f"<Content><![CDATA[{escape_cdata(content)}]]></Content>"
        "</xml>"
    )


def text_content(msg):
    """从消息 dict 里取文本内容；非文本消息返回 None。"""
    if msg.get("MsgType") != "text":
        return None
    return msg.get("Content", "")


def describe(msg):
    """给日志用的一行摘要。"""
    t = msg.get("MsgType", "?")
    who = msg.get("FromUserName", "?")
    if t == "text":
        return f"[text] {who}: {msg.get('Content', '')[:80]}"
    if t == "event":
        return f"[event] {who}: {msg.get('Event', '')} {msg.get('EventKey', '')}"
    return f"[{t}] {who}"
