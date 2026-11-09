"""把 server/desk/public/icon-512.png 转成 Android 各密度图标。

两套：
- 传统 ic_launcher.png（48/72/96/144/192）：整张图缩放到满铺
- 自适应前景 ic_fore.png（108dp 画布的 62%）：先裁掉原图留白再居中，
  否则在 Android 8+ 的圆形蒙版里小狗会缩成一小坨

背景色从原图角落取，写进 colors.xml，保证蒙版边缘和原图底色一致。
"""
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "server", "desk", "public", "icon-512.png")
RES = os.path.join(ROOT, "android", "res")

LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
ADAPTIVE = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}


def content_box(img):
    """找出主体边界：把和角落同色的像素当背景。"""
    rgb = img.convert("RGB")
    w, h = rgb.size
    bg = rgb.getpixel((2, 2))

    def near(p, q, tol=26):
        return abs(p[0] - q[0]) <= tol and abs(p[1] - q[1]) <= tol and abs(p[2] - q[2]) <= tol

    px = rgb.load()
    left, right, top, bottom = w, -1, h, -1
    step = 2
    for y in range(0, h, step):
        for x in range(0, w, step):
            if not near(px[x, y], bg):
                if x < left:
                    left = x
                if x > right:
                    right = x
                if y < top:
                    top = y
                if y > bottom:
                    bottom = y
    if right < 0:
        return (0, 0, w, h)
    pad = 6
    return (max(0, left - pad), max(0, top - pad),
            min(w, right + pad + 1), min(h, bottom + pad + 1))


def main():
    if not os.path.exists(SRC):
        sys.exit("找不到源图: " + SRC)

    img = Image.open(SRC).convert("RGBA")
    bg = img.convert("RGB").getpixel((2, 2))
    hexbg = "#%02x%02x%02x" % bg
    box = content_box(img)
    core = img.crop(box)
    cw, ch = core.size
    ratio = cw / float(ch)
    print("源图 %s 背景 %s 主体框 %s (%dx%d 宽高比 %.2f)" % (img.size, hexbg, box, cw, ch, ratio))

    for dpi, size in LEGACY.items():
        d = os.path.join(RES, "mipmap-" + dpi)
        os.makedirs(d, exist_ok=True)
        img.resize((size, size), Image.LANCZOS).save(os.path.join(d, "ic_launcher.png"))

    for dpi, canvas in ADAPTIVE.items():
        d = os.path.join(RES, "mipmap-" + dpi)
        os.makedirs(d, exist_ok=True)
        target = int(round(canvas * 0.68))
        if ratio >= 1:
            tw, th = target, int(round(target / ratio))
        else:
            tw, th = int(round(target * ratio)), target
        fg = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        piece = core.resize((tw, th), Image.LANCZOS)
        fg.paste(piece, ((canvas - tw) // 2, (canvas - th) // 2), piece)
        fg.save(os.path.join(d, "ic_fore.png"))
        print("  %-8s 传统 %3dpx  自适应 %3dpx (狗 %dx%d)" % (dpi, LEGACY[dpi], canvas, tw, th))

    with open(os.path.join(RES, "values", "colors.xml"), "w", encoding="utf-8", newline="\n") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n')
        f.write('    <color name="iconBg">%s</color>\n' % hexbg)
        f.write("</resources>\n")

    anydpi = os.path.join(RES, "mipmap-anydpi-v26")
    os.makedirs(anydpi, exist_ok=True)
    with open(os.path.join(anydpi, "ic_launcher.xml"), "w", encoding="utf-8", newline="\n") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n')
        f.write('<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n')
        f.write('    <background android:drawable="@color/iconBg" />\n')
        f.write('    <foreground android:drawable="@mipmap/ic_fore" />\n')
        f.write("</adaptive-icon>\n")
    print("写入 colors.xml 与 mipmap-anydpi-v26/ic_launcher.xml")


if __name__ == "__main__":
    main()
