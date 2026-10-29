"""
通用区域探针：给一个区域，出「逐像素色块图 + OCR 文字」。

用法：
  .workbuddy/wechat-bot/.venv/Scripts/python.exe wechat-bot/probe_region.py x1 y1 x2 y2 [每格像素]
不给坐标则默认看窗口底部（输入框那一带）。
"""

import asyncio
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ocr as ocr_mod
import vision

LEGEND = (". 亮底  浅底  # 深色  - 中灰  + 其他  G 绿  R 红  B 蓝")


def sym(px):
    r, g, b = px
    mx, mn = max(px), min(px)
    if g > 120 and g - r > 40 and g - b > 30:
        return "G"
    if r > 150 and r - g > 50 and r - b > 40:
        return "R"
    if b > 120 and b - r > 30 and b - g > 20:
        return "B"
    if mx < 90:
        return "#"
    if mx < 170:
        return "-"
    if mn > 245:
        return "."
    if mn > 225:
        return " "
    return "+"


def main():
    s = vision.capture()
    if s is None:
        print("没找到微信主窗口")
        return 1
    w, h = s.rect[2], s.rect[3]
    print(f"窗口 {w}x{h} @({s.rect[0]},{s.rect[1]}) 缩放 {s.scale}% "
          f"k={s.k:.4f} 分界列 {s.boundary}")
    print(f"message 区 {s.regions['message']}  ->  底部 {(s.regions['message'][3] / h):.4f} 处")

    if len(sys.argv) >= 5:
        x1, y1, x2, y2 = (int(v) for v in sys.argv[1:5])
        cell = int(sys.argv[5]) if len(sys.argv) > 5 else 8
    else:
        x1, y1 = s.boundary or 384, s.regions["message"][3]
        x2, y2 = w, h
        cell = 8

    print(f"\n区域 ({x1},{y1})-({x2},{y2})  每格 {cell}px")
    print("图例: " + LEGEND)

    crop = s.img.crop((x1, y1, x2, y2)).convert("RGB")
    cw, ch = crop.size
    cols = max(1, cw // cell)
    rows = max(1, ch // cell)
    small = crop.resize((cols, rows))
    px = small.load()
    print(f"\n色块图 {cols} 列 x {rows} 行（每格 {cell}x{cell}px）")
    print("      " + "".join(str((x1 + c * cell) // 100 % 10) for c in range(cols)))
    print("      " + "".join(str((x1 + c * cell) // 10 % 10) for c in range(cols)))
    for r in range(rows):
        print(f"{y1 + r * cell:5d} " + "".join(sym(px[c, r]) for c in range(cols)))

    print("\n=== 该区域 OCR ===")
    res = asyncio.run(ocr_mod.ocr(crop))
    lines = []
    for line in res.lines:
        ws = list(line.words)
        if not ws:
            continue
        lines.append((x1 + int(min(x.bounding_rect.x for x in ws)),
                      y1 + int(min(x.bounding_rect.y for x in ws)),
                      line.text))
    for x, y, t in sorted(lines, key=lambda r2: (r2[1], r2[0])):
        print(f"  x={x:>4} y={y:>4} {t!r}")
    if not lines:
        print("  （没读到文字）")

    print("\n=== 该区域主色（判断底色/是否有内容）===")
    for c, n in Counter(crop.getdata()).most_common(5):
        print(f"  {c}  {n:6d}px")
    return 0


if __name__ == "__main__":
    sys.exit(main())
