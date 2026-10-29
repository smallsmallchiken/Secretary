"""
微信 4.x 视觉布局判据。

常量移植自 wens6515/weixin-wechat-wxauto-ocr-xiaoli（MIT）的
wx_backend/visual_regions.py 与 visual_badge.py，均为真机逐像素标定值。

标定前提（对方项目定的，很关键）：
  - 标定档位 175% 缩放，标定窗口 1300x1610（2560x1600 屏的右半）
  - 微信布局按**逻辑像素**固定：会话列表固定像素宽、输入框固定像素高，
    所以区域四沿是「距窗口边缘的固定逻辑距离」，**不能按窗口比例存**
  - 元素物理尺寸 = 标定物理值 x k，k = 当前档位 / 175
  - 窗口被拖出屏幕或窗口过窄时微信会压缩会话列，静态锚失准，
    需要实测分界列（见 detect_boundary_x）

区域锚点符号约定：(l, t, r, b)
  l / t 恒为「距左 / 距顶」
  r / b 负值 = 距右 / 距底，正值 = 距左 / 距顶
"""

import numpy as np

CALIB_SCALE = 175.0
CALIB_WINDOW = (1300, 1610)

# 175% 标定物理像素。(541.45, 207.4, -11.31, -267.7) 的 message 底部
# 刻意不含输入框：输入框「发送」按钮在窗口 ~0.95 处，含进去 OCR 会把
# 按钮文字当成消息。
REGION_EDGES = {
    "session": (117.0, 141.4, 543.4, -16.9),
    "message": (541.45, 207.4, -11.31, -267.7),
    "title": (539.63, 62.1, -243.36, 132.0),
}

# 未读红圈：固定品牌红 #FA5151，不是「红色范围」。
# ±5 而非零容差：零容差换台机器就可能整簇掉出面积闸，
# 失败模式是静默收不到所有消息，比误报严重。
BADGE_RED = (250, 81, 81)
BADGE_TOL = 5
# 8 邻接连通域像素数。真角标约 26x27 ~= 518px，不随未读条数变宽。
# 下限排除噪声像素（实测微信自己的小图标能出 14~22px 的簇），
# 上限排除红色头像/大块红色图形。
BADGE_AREA_MIN = 60
BADGE_AREA_MAX = 1000
# 红圈 -> 会话名的二维曼哈顿距离上限（列表区局部像素，175% 标定）。
# 实测名字 Δ≈15、角标数字 Δ≈35、时间戳/预览行 Δ≥50。
# 必须用二维：只看 y 时名字 Δy=0、时间戳 Δy=2，2px 之差就翻车。
BADGE_ANCHOR_MAX_DIST = 80
# 红圈在头像左上角，条目主体在头像右侧 ~45px
BADGE_CLICK_OFFSET_X = 45
# 同一行红圈簇归并容差（行高约 113px）
BADGE_ROW_TOL = 40

# 会话列表选中高亮：浅色主题 ≈ #F0F0F0，未选中纯白 #FFFFFF，差值 15~25。
# PrintWindow 像素噪声 <3，容差取 12 夹在两者之间。
ROW_SELECTED = (240, 240, 240)
ROW_NORMAL = (255, 255, 255)
ROW_COLOR_TOL = 12


def k_for_scale(scale):
    """当前 DPI 档位 -> 缩放系数 k（相对 175% 标定）。"""
    return float(scale) / CALIB_SCALE


def area_for_scale(px, scale):
    """长度按 k 缩放 -> 面积按 k² 缩放（原项目 _area() 的口径）。

    漏掉这一步会让面积闸在低档位偏严：125% 下 k²=0.51，
    真角标实际约 265px 却按 175% 的 60 当下限，余量被吃光。
    """
    k = k_for_scale(scale)
    return px * k * k


def regions_for_window(w, h, scale, boundary_px=None):
    """窗口物理尺寸 -> 三区域 (l, t, r, b)，物理像素，相对窗口左上角。

    boundary_px：实测会话|聊天分界列。窗口逻辑宽小于标定窗口时微信压缩
    会话列，静态锚 543.4 x k 失准（对方 200% 真机实测）。传入即覆盖
    session 右沿与 message/title 左沿（三沿都锚在分界列上）。
    """
    if w <= 0 or h <= 0:
        return {}
    k = k_for_scale(scale)
    boundary = boundary_px if (boundary_px and 0 < boundary_px < w) else None
    out = {}
    for key, (l_px, t_px, r_px, b_px) in REGION_EDGES.items():
        l = l_px * k
        r = (w + r_px * k) if r_px < 0 else r_px * k
        if boundary is not None:
            if key == "session":
                r = boundary
            else:
                l = boundary
        t = t_px * k if t_px >= 0 else h + t_px * k
        b = b_px * k if b_px >= 0 else h + b_px * k
        l = min(max(l, 0.0), w)
        r = min(max(r, l), w)
        t = min(max(t, 0.0), h)
        b = min(max(b, t), h)
        out[key] = (int(round(l)), int(round(t)), int(round(r)), int(round(b)))
    return out


def detect_boundary_x(shot, scale, y_band=None):
    """空谷扫描实测「会话列表 | 聊天区」分界列。

    会话列表右缘是一条基本无内容的竖直窄带（列表背景），聊天区从分界列
    右侧重新出现内容（头像列）。做法：在会话列表 y 范围内按列统计「非背景
    像素」数，取静态锚附近一段里最空的那一列。

    返回物理像素 x，找不到返回 None。
    """
    w, h = shot.size
    k = k_for_scale(scale)
    anchor = int(543.4 * k)
    lo = max(0, anchor - int(40 * k))
    hi = min(w, anchor + int(40 * k))
    if hi - lo < 8:
        return None
    if y_band is None:
        y_band = (int(141.4 * k), int(h - 16.9 * k))
    t, b = max(0, y_band[0]), min(h, y_band[1])
    if b - t < 20:
        return None
    arr = np.asarray(shot.convert("RGB").crop((lo, t, hi, b)))
    # 背景 = 该带内出现最多的颜色（列表底色）
    flat = arr.reshape(-1, 3)
    colors, counts = np.unique(flat, axis=0, return_counts=True)
    bg = colors[counts.argmax()]
    nonbg = (np.abs(arr.astype(np.int16) - bg.astype(np.int16)).sum(axis=2) > 24)
    col_hits = nonbg.sum(axis=0)
    return lo + int(col_hits.argmin())


def red_clusters(shot, region, tol=BADGE_TOL, min_area=1):
    """诊断用：区域内所有命中品牌红的连通域，不做面积过滤。

    返回 [(l, t, r, b, n, mean_rgb), ...]，坐标是整窗物理像素。
    用来区分「真角标」和「红色头像 / 红心 emoji / 其它红色 UI」——
    光看面积闸分不出来，得看实际颜色和形状。
    """
    sl, st, sr, sb = region
    crop = shot.convert("RGB").crop((sl, st, sr, sb))
    rw, rh = crop.size
    if rw <= 0 or rh <= 0:
        return []
    arr = np.asarray(crop).astype(np.int16)
    mask = ((np.abs(arr[:, :, 0] - BADGE_RED[0]) <= tol)
            & (np.abs(arr[:, :, 1] - BADGE_RED[1]) <= tol)
            & (np.abs(arr[:, :, 2] - BADGE_RED[2]) <= tol))
    ys, xs = np.where(mask)
    if len(ys) == 0:
        return []
    seen = np.zeros((rh, rw), dtype=bool)
    out = []
    for sy, sx in zip(ys.tolist(), xs.tolist()):
        if seen[sy, sx]:
            continue
        stack = [(sy, sx)]
        seen[sy, sx] = True
        pts = []
        while stack:
            cy, cx = stack.pop()
            pts.append((cy, cx))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = cy + dy, cx + dx
                    if (0 <= ny < rh and 0 <= nx < rw
                            and mask[ny, nx] and not seen[ny, nx]):
                        seen[ny, nx] = True
                        stack.append((ny, nx))
        n = len(pts)
        if n < min_area:
            continue
        minx = min(p[1] for p in pts)
        maxx = max(p[1] for p in pts)
        miny = min(p[0] for p in pts)
        maxy = max(p[0] for p in pts)
        mean = arr[[p[0] for p in pts], [p[1] for p in pts]].mean(axis=0)
        out.append((sl + minx, st + miny, sl + maxx, st + maxy, n,
                    tuple(int(round(v)) for v in mean)))
    return sorted(out, key=lambda c: -c[4])


def detect_badges(shot, scale, region=None, boundary_px=None):
    """会话列表区的未读红圈，返回 [(l, t, r, b), ...]，整窗物理像素坐标。

    判据 = 固定品牌红 (250,81,81) 每通道 ±5 + 8 邻接连通域面积 [60, 1000]。
    """
    if shot is None:
        return []
    w, h = shot.size
    if region is None:
        regs = regions_for_window(w, h, scale, boundary_px)
        if not regs:
            return []
        region = regs["session"]
    sl, st, sr, sb = region
    crop = shot.convert("RGB").crop((sl, st, sr, sb))
    rw, rh = crop.size
    if rw <= 0 or rh <= 0:
        return []
    arr = np.asarray(crop).astype(np.int16)
    mask = ((np.abs(arr[:, :, 0] - BADGE_RED[0]) <= BADGE_TOL)
            & (np.abs(arr[:, :, 1] - BADGE_RED[1]) <= BADGE_TOL)
            & (np.abs(arr[:, :, 2] - BADGE_RED[2]) <= BADGE_TOL))
    ys, xs = np.where(mask)
    if len(ys) == 0:
        return []
    seen = np.zeros((rh, rw), dtype=bool)
    out = []
    for sy, sx in zip(ys.tolist(), xs.tolist()):
        if seen[sy, sx]:
            continue
        stack = [(sy, sx)]
        seen[sy, sx] = True
        n = 0
        minx = maxx = sx
        miny = maxy = sy
        while stack:
            cy, cx = stack.pop()
            n += 1
            minx = min(minx, cx)
            maxx = max(maxx, cx)
            miny = min(miny, cy)
            maxy = max(maxy, cy)
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = cy + dy, cx + dx
                    if (0 <= ny < rh and 0 <= nx < rw
                            and mask[ny, nx] and not seen[ny, nx]):
                        seen[ny, nx] = True
                        stack.append((ny, nx))
        if (area_for_scale(BADGE_AREA_MIN, scale)
                <= n <= area_for_scale(BADGE_AREA_MAX, scale)):
            out.append((sl + minx, st + miny, sl + maxx, st + maxy))
    return sorted(out)


def pick_block_near_badge(badge, blocks, scale, max_dist=None):
    """红圈锚定：取距红圈最近的文本块（会话名），超阈值返回 None。

    必须用二维曼哈顿距离。原项目真机实测（列表区局部坐标）：
        真角标 (82,22) -> '林小满'(97,22) Δ=15 ；'20:33'(349,24) Δ=269
        只看 y：名字 Δy=0，时间戳 Δy=2 —— 2px 之差直接翻车
    带上 x 之后两者差一个数量级。

    badge 与 blocks 必须同一坐标系。blocks 是 [{'text','x','y',...}]。
    超阈值返回 None：宁可不处理，也不猜是哪个会话。
    """
    if not blocks:
        return None
    if max_dist is None:
        max_dist = BADGE_ANCHOR_MAX_DIST * k_for_scale(scale)
    bx = (badge[0] + badge[2]) / 2.0
    by = (badge[1] + badge[3]) / 2.0
    best, best_d = None, None
    for it in blocks:
        d = abs(it["x"] - bx) + abs(it["y"] - by)
        if best_d is None or d < best_d:
            best_d, best = d, it
    if best is None or best_d > max_dist:
        return None
    return best


def click_point_for_badge(badge, scale):
    """红圈 -> 条目点击点。红圈在头像左上角，条目主体在头像右侧 ~45px。"""
    off = int(round(BADGE_CLICK_OFFSET_X * k_for_scale(scale)))
    return (badge[0] + off, (badge[1] + badge[3]) // 2)


def row_selected_color(shot, row_box):
    """该行是否为选中态（浅灰高亮）。返回 (是否选中, 该行主色)。"""
    from collections import Counter
    crop = shot.convert("RGB").crop(row_box)
    if crop.size[0] <= 0 or crop.size[1] <= 0:
        return False, None
    top = Counter(crop.getdata()).most_common(1)[0][0]
    sel = all(abs(a - b) <= ROW_COLOR_TOL for a, b in zip(top, ROW_SELECTED))
    return sel, top

def merge_badges_same_row(badges, scale):
    """同一行的多个红圈簇归并（不需要会话名就能去重）。"""
    tol = BADGE_ROW_TOL * k_for_scale(scale)
    rows = []
    for b in sorted(badges, key=lambda t: t[1]):
        for row in rows:
            if abs(row[1] - b[1]) <= tol:
                row[0] = min(row[0], b[0])
                row[1] = min(row[1], b[1])
                row[2] = max(row[2], b[2])
                row[3] = max(row[3], b[3])
                break
        else:
            rows.append(list(b))
    return [tuple(r) for r in rows]
