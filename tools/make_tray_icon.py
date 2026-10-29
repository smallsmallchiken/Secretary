"""把用户给的比格犬梗图做成托盘图标。

流程：
  1. 从四边泛洪填充去掉白底（只删与边界连通的白色，保住嘴部白毛）
  2. 连通域分析，只保留面积最大的那块（即狗本身），
     自动丢掉周围的 "Wer wer wer~" 和 "耶！" 手写字
  3. 裁到内容边界，补成正方形，输出 256x256 透明 PNG
"""

from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "assets" / "tray-source.png"
OUT = ROOT / "src" / "assets" / "tray-head.png"
PREVIEW = ROOT / ".workbuddy" / "tmp" / "tray-head-preview.png"

CANVAS = 256
MARGIN_RATIO = 0.02
WHITE_MIN = 232


def remove_white_background(im: Image.Image) -> Image.Image:
    """只把和边界连通的白像素变透明，内部的白色毛发保留。"""
    arr = np.array(im, dtype=np.uint8)
    h, w = arr.shape[:2]
    rgb = arr[:, :, :3].astype(np.int16)
    near_white = rgb.min(axis=2) >= WHITE_MIN

    visited = np.zeros((h, w), dtype=bool)
    q = deque()

    for x in range(w):
        for y in (0, h - 1):
            if near_white[y, x] and not visited[y, x]:
                visited[y, x] = True
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if near_white[y, x] and not visited[y, x]:
                visited[y, x] = True
                q.append((x, y))

    while q:
        x, y = q.popleft()
        arr[y, x, 3] = 0
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not visited[ny, nx] and near_white[ny, nx]:
                visited[ny, nx] = True
                q.append((nx, ny))

    return Image.fromarray(arr, "RGBA")


def trim_halo(im: Image.Image, rounds: int = 1) -> Image.Image:
    """削掉一圈半透明的浅色残边（白底抗锯齿留下的白圈）。

    只对"浅色且贴着透明区域"的像素动手，深色的黑色描边不会变细。
    """
    arr = np.array(im, dtype=np.uint8)
    for _ in range(rounds):
        alpha = arr[:, :, 3]
        solid = alpha > 8
        # 4 邻域里有一个是透明的像素 = 边界像素
        edge = np.zeros_like(solid)
        edge[1:, :] |= ~solid[:-1, :]
        edge[:-1, :] |= ~solid[1:, :]
        edge[:, 1:] |= ~solid[:, :-1]
        edge[:, :-1] |= ~solid[:, 1:]
        rgb_min = arr[:, :, :3].astype(np.int16).min(axis=2)
        # 边界上发灰/发白的过渡像素直接砍掉，纯黑描边（min<90）保留
        kill = solid & edge & (rgb_min >= 90)
        arr[:, :, 3] = np.where(kill, 0, alpha)
    return Image.fromarray(arr, "RGBA")


def largest_component(im: Image.Image) -> Image.Image:
    """只留面积最大的连通块，顺手把周围的手写文字丢掉。"""
    alpha = np.array(im.split()[3]) > 8
    h, w = alpha.shape
    seen = np.zeros((h, w), dtype=bool)
    best: list[tuple[int, int]] = []

    for start_y in range(h):
        row = alpha[start_y]
        for start_x in range(w):
            if not row[start_x] or seen[start_y, start_x]:
                continue
            comp: list[tuple[int, int]] = []
            q = deque([(start_x, start_y)])
            seen[start_y, start_x] = True
            while q:
                x, y = q.popleft()
                comp.append((x, y))
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        nx, ny = x + dx, y + dy
                        if (
                            0 <= nx < w
                            and 0 <= ny < h
                            and not seen[ny, nx]
                            and alpha[ny, nx]
                        ):
                            seen[ny, nx] = True
                            q.append((nx, ny))
            if len(comp) > len(best):
                best = comp

    keep = np.zeros((h, w), dtype=bool)
    for x, y in best:
        keep[y, x] = True

    arr = np.array(im, dtype=np.uint8)
    arr[~keep, 3] = 0
    print(f"最大连通块 {len(best)} px，占全图 {len(best) / (h * w):.1%}")
    return Image.fromarray(arr, "RGBA")


def main() -> None:
    im = Image.open(SRC).convert("RGBA")
    im = remove_white_background(im)
    im = trim_halo(im, rounds=2)
    im = largest_component(im)

    bbox = im.split()[3].getbbox()
    im = im.crop(bbox)
    print("裁切后尺寸:", im.size)

    side = int(max(im.size) * (1 + MARGIN_RATIO * 2))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.alpha_composite(im, ((side - im.width) // 2, (side - im.height) // 2))

    canvas = canvas.resize((CANVAS, CANVAS), Image.LANCZOS)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT)
    print("输出:", OUT, canvas.size)

    preview = Image.new("RGBA", (CANVAS + 150, CANVAS), (38, 42, 50, 255))
    preview.alpha_composite(canvas, (0, 0))
    for i, size in enumerate((20, 32, 48)):
        s = canvas.copy()
        s.thumbnail((size, size), Image.LANCZOS)
        preview.alpha_composite(s, (CANVAS + 24 + i * 40, 40 + (72 - s.height) // 2))
    preview.convert("RGB").save(PREVIEW)
    print("预览:", PREVIEW)


if __name__ == "__main__":
    main()
