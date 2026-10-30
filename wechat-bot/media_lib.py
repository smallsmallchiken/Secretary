"""共享媒体库（Python 侧）。

和 QQ 那边 `src/core/media/library.js` 读**同一份** `.data/media/library.json`：
表情包、图片、语音片段和 TTS 缓存两边共用一池。所以这个文件的格式必须和 JSON
那侧严格一致 —— 改一边就要同步改另一边，否则两个进程会互相覆盖对方的条目。

    .data/media/
      pics/          所有图片（表情包 / 梗图 / 普通图）
      voice/         所有音频（预置片段 + TTS 缓存）
      library.json   统一索引

设计原则和 JS 侧一致：
- **目录里的文件才是真相**，索引只是补充信息（描述 / 来源 / 使用次数）。
  手工往 pics/ 里拷图，`sync_from_disk()` 会自动补录。
- 写盘用「临时文件 + 原子替换」，且改前强制重读，把双进程并发写压到最小窗口。
- 新增素材时先落文件再写索引：宁可有孤儿文件，也别丢图。
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(HERE)

PIC_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")
MIN_PIC_BYTES = 1200
SCAN_THROTTLE_SECONDS = 5.0

_cache = {"stamp": None, "data": None}
_last_scan = 0.0


# ------------------------------------------------------------------ 路径

def _data_dir() -> str:
    override = os.environ.get("PET_DATA_DIR")
    if override:
        return os.path.abspath(override)
    return os.path.join(PROJECT_ROOT, ".data")


def root() -> str:
    return os.path.join(_data_dir(), "media")


def pics_dir() -> str:
    d = os.path.join(root(), "pics")
    os.makedirs(d, exist_ok=True)
    return d


def voice_dir() -> str:
    d = os.path.join(root(), "voice")
    os.makedirs(d, exist_ok=True)
    return d


def index_path() -> str:
    return os.path.join(root(), "library.json")


# ------------------------------------------------------------------ 索引

def _empty():
    return {"version": 2, "seq": 0, "pics": [], "voice": []}


def _stamp() -> str:
    try:
        st = os.stat(index_path())
        return f"{st.st_mtime}:{st.st_size}"
    except OSError:
        return "none"


def load_index(force: bool = False) -> dict:
    stamp = _stamp()
    if not force and _cache["stamp"] == stamp and _cache["data"] is not None:
        return _cache["data"]
    data = _empty()
    if stamp != "none":
        try:
            with open(index_path(), "r", encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                data.update(raw)
                if not isinstance(data.get("pics"), list):
                    data["pics"] = []
                if not isinstance(data.get("voice"), list):
                    data["voice"] = []
        except (OSError, ValueError):
            data = _empty()
    _cache["stamp"] = stamp
    _cache["data"] = data
    return data


def save_index(data: dict) -> bool:
    path = index_path()
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
        _cache["stamp"] = _stamp()
        _cache["data"] = data
        return True
    except OSError:
        _cache["stamp"] = None
        _cache["data"] = None
        try:
            os.remove(tmp)
        except OSError:
            pass
        return False


# ------------------------------------------------------------------ 图片

def _safe_name(name: str) -> str | None:
    s = str(name or "").strip()
    if not s or "/" in s or "\\" in s or ".." in s:
        return None
    return s


def _guess_kind(name: str) -> str:
    low = name.lower()
    if any(k in low for k in ("meme", "sticker", "表情", "梗", "doge")) or low.endswith(".gif"):
        return "sticker"
    return "pic"


def sync_from_disk(force: bool = False) -> int:
    """把目录里没进索引的图补录进来。节流 5 秒一次。"""
    global _last_scan
    now = time.time()
    if not force and now - _last_scan < SCAN_THROTTLE_SECONDS:
        return 0
    _last_scan = now
    added = 0
    try:
        d = pics_dir()
        idx = load_index(force=True)
        known = {x.get("id") for x in idx["pics"]}
        for f in os.listdir(d):
            if os.path.splitext(f)[1].lower() not in PIC_EXTS or f in known:
                continue
            p = os.path.join(d, f)
            if not os.path.isfile(p):
                continue
            try:
                mtime = os.path.getmtime(p) * 1000
            except OSError:
                mtime = time.time() * 1000
            idx["pics"].append({
                "id": f, "hash": "", "kind": _guess_kind(f), "desc": "",
                "from": "manual", "addedAt": mtime, "uses": 0, "lastUsedAt": 0,
            })
            added += 1
        if added:
            save_index(idx)
    except OSError:
        pass
    return added


def list_pics(kind: str | None = None) -> list[dict]:
    sync_from_disk()
    d = pics_dir()
    out = []
    for x in load_index()["pics"]:
        if kind and x.get("kind") != kind:
            continue
        p = os.path.join(d, x.get("id") or "")
        if os.path.isfile(p):
            out.append({**x, "path": p})
    return out


def find_pic(pic_id: str) -> str | None:
    name = _safe_name(pic_id)
    if not name:
        return None
    p = os.path.join(pics_dir(), name)
    return p if os.path.isfile(p) else None


def pick_pic(kind: str | None = "sticker", exclude: list[str] | None = None) -> str | None:
    """随机挑一张图的路径。exclude 传刚发过的文件名，避免连着发同一张。"""
    pool = list_pics(kind)
    if not pool:
        return None
    excl = set(exclude or [])
    fresh = [x for x in pool if x.get("id") not in excl]
    item = random.choice(fresh or pool)
    note_pic_used(item.get("id"))
    return item["path"]


_dirty_pics = 0


def note_pic_used(pic_id: str) -> None:
    global _dirty_pics
    if not pic_id:
        return
    idx = load_index()
    for x in idx["pics"]:
        if x.get("id") == pic_id:
            x["uses"] = int(x.get("uses") or 0) + 1
            x["lastUsedAt"] = int(time.time() * 1000)
            _dirty_pics += 1
            if _dirty_pics >= 8:
                _dirty_pics = 0
                save_index(idx)
            return


def set_pic_desc(pic_id: str, desc: str) -> bool:
    name = _safe_name(pic_id)
    if not name:
        return False
    idx = load_index(force=True)
    for x in idx["pics"]:
        if x.get("id") == name:
            x["desc"] = str(desc or "")[:40]
            return save_index(idx)
    return False


MAX_PICS = 500


def _sniff_ext(data: bytes) -> str:
    if len(data) > 8 and data[0] == 0x89 and data[1] == 0x50:
        return ".png"
    if len(data) > 4 and data[0] == 0x47 and data[1] == 0x49:
        return ".gif"
    if len(data) > 4 and data[:4] == b"RIFF":
        return ".webp"
    if len(data) > 3 and data[0] == 0x42 and data[1] == 0x4D:
        return ".bmp"
    return ".jpg"


def _prune_pics(idx: dict) -> None:
    if len(idx["pics"]) <= MAX_PICS:
        return
    victims = sorted(
        idx["pics"],
        key=lambda x: (int(x.get("uses") or 0), int(x.get("lastUsedAt") or 0)),
    )[: len(idx["pics"]) - MAX_PICS]
    dead = {x.get("id") for x in victims}
    idx["pics"] = [x for x in idx["pics"] if x.get("id") not in dead]
    for v in victims:
        try:
            os.remove(os.path.join(pics_dir(), v.get("id") or ""))
        except OSError:
            pass


def add_pic(data: bytes, kind: str = "sticker", desc: str = "",
            source: str = "wechat", name: str | None = None) -> dict | None:
    """收一张图进共享池（md5 去重）。返回条目（含 path），失败 None。"""
    if not data or len(data) < MIN_PIC_BYTES:
        return None
    h = hashlib.md5(data).hexdigest()
    idx = load_index(force=True)  # 强制重读：QQ 那边可能刚写过
    for x in idx["pics"]:
        if x.get("hash") == h:
            p = os.path.join(pics_dir(), x.get("id") or "")
            if os.path.isfile(p):
                return {**x, "path": p}

    seq = int(idx.get("seq") or 0) + 1
    idx["seq"] = seq
    fname = _safe_name(name) or f"meme-{seq}{_sniff_ext(data)}"
    path = os.path.join(pics_dir(), fname)
    try:
        with open(path, "wb") as f:   # 先落文件再写索引：宁可有孤儿，别丢图
            f.write(data)
    except OSError:
        return None
    item = {
        "id": fname, "hash": h, "kind": kind, "desc": str(desc or "")[:40],
        "from": source, "addedAt": int(time.time() * 1000), "uses": 0, "lastUsedAt": 0,
    }
    idx["pics"].append(item)
    _prune_pics(idx)
    save_index(idx)
    return {**item, "path": path}


def add_pic_from_file(path: str, **kwargs) -> dict | None:
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return None
    return add_pic(data, **kwargs)


# ------------------------------------------------------------------ 语音

def voice_hash(text: str, voice: str, model: str) -> str:
    raw = f"{model or ''}|{voice or ''}|{str(text or '').strip()}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def _voice_exists(name: str) -> bool:
    n = _safe_name(name)
    return bool(n) and os.path.isfile(os.path.join(voice_dir(), n))


def find_voice(text: str, voice: str, model: str) -> str | None:
    """找现成音频：优先人工预置片段，其次同文本的合成缓存。"""
    clean = str(text or "").strip()
    if not clean:
        return None
    idx = load_index()
    for x in idx["voice"]:
        if x.get("kind") == "preset" and x.get("text") == clean and _voice_exists(x.get("id")):
            return os.path.join(voice_dir(), x["id"])
    key = voice_hash(clean, voice, model)
    for x in idx["voice"]:
        if x.get("hash") == key and _voice_exists(x.get("id")):
            note_voice_used(x.get("id"))
            return os.path.join(voice_dir(), x["id"])
    return None


def find_preset(text: str) -> dict | None:
    clean = str(text or "").strip()
    if not clean:
        return None
    presets = [x for x in load_index()["voice"]
               if x.get("kind") == "preset" and _voice_exists(x.get("id"))]
    for x in presets:
        if x.get("text") == clean:
            return {**x, "path": os.path.join(voice_dir(), x["id"])}
    for x in presets:
        t = x.get("text") or ""
        if t and (t in clean or clean in t):
            return {**x, "path": os.path.join(voice_dir(), x["id"])}
    return None


def voice_by_id(vid: str) -> str | None:
    n = _safe_name(vid)
    if not n:
        return None
    p = os.path.join(voice_dir(), n)
    return p if os.path.isfile(p) else None


def list_presets() -> list[dict]:
    return [x for x in load_index()["voice"]
            if x.get("kind") == "preset" and _voice_exists(x.get("id"))]


def preset_list_text(max_n: int = 20) -> str:
    """提示词用的预置语音清单：`[语音:晚安]、[语音:嗯嗯]`。"""
    items = sorted(list_presets(), key=lambda x: x.get("addedAt") or 0, reverse=True)
    return "、".join(f"[语音:{x.get('text')}]" for x in items[:max_n])


def put_voice(data: bytes, text: str, voice: str, model: str,
              kind: str = "tts", vid: str | None = None, desc: str = "",
              source: str = "wechat") -> str | None:
    """存一段音频进共享池，返回文件路径。已存在同文本同音色的直接复用。"""
    if not data:
        return None
    clean = str(text or "").strip()
    key = voice_hash(clean, voice, model)
    idx = load_index(force=True)
    for x in idx["voice"]:
        if x.get("hash") == key and x.get("kind") == kind and _voice_exists(x.get("id")):
            return os.path.join(voice_dir(), x["id"])
    name = _safe_name(vid) or f"v-{key[:10]}.mp3"
    try:
        with open(os.path.join(voice_dir(), name), "wb") as f:
            f.write(data)
    except OSError:
        return None
    idx["voice"].append({
        "id": name, "hash": key, "text": clean, "kind": kind,
        "desc": str(desc or "")[:30], "voice": voice or "", "model": model or "",
        "from": source, "addedAt": int(time.time() * 1000), "uses": 0, "lastUsedAt": 0,
    })
    save_index(idx)
    return os.path.join(voice_dir(), name)


_dirty_voice = 0


def note_voice_used(vid: str) -> None:
    global _dirty_voice
    if not vid:
        return
    idx = load_index()
    for x in idx["voice"]:
        if x.get("id") == vid:
            x["uses"] = int(x.get("uses") or 0) + 1
            x["lastUsedAt"] = int(time.time() * 1000)
            _dirty_voice += 1
            if _dirty_voice >= 8:
                _dirty_voice = 0
                save_index(idx)
            return


# ------------------------------------------------------------------ 统计

def stats() -> dict:
    idx = load_index()
    return {
        "root": root(),
        "pics": len(idx["pics"]),
        "stickers": len([x for x in idx["pics"] if x.get("kind") == "sticker"]),
        "voice": len(idx["voice"]),
        "presets": len([x for x in idx["voice"] if x.get("kind") == "preset"]),
    }


if __name__ == "__main__":
    s = stats()
    print(f"共享媒体库：{s['root']}")
    print(f"  图片 {s['pics']} 张（表情包 {s['stickers']}）")
    print(f"  语音 {s['voice']} 段（预置 {s['presets']}）")
    for p in list_pics("sticker")[:10]:
        print(f"    [图:{p['id']}] {p.get('desc') or '(未打标)'}")
