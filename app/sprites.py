"""精灵图切帧工具。

duodong 的 spritesheet 是 1536x1872 的 lossless webp，按 8 列 x 9 行切分，
单帧 192x208。每行动作的有效帧数不同，由 config 里的 anims 指定。
"""

from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtGui import QImage, QPixmap

FRAME_W = 192
FRAME_H = 208
COLS = 8
ROWS = 9


class SpriteSheet:
    """按 (行, 列, 缩放) 取帧，并缓存成 QPixmap。"""

    def __init__(self, path: Path):
        path = Path(path)
        if not path.exists():
            raise FileNotFoundError(f"找不到精灵图: {path}")
        img = QImage(str(path))
        if img.isNull():
            raise RuntimeError(f"精灵图读取失败（格式不支持？）: {path}")
        self._img = img.convertToFormat(QImage.Format.Format_ARGB32)
        self._cache: dict[tuple[int, int, float], QPixmap] = {}

    @property
    def size(self) -> tuple[int, int]:
        return self._img.width(), self._img.height()

    def frame(self, row: int, col: int, scale: float) -> QPixmap:
        row = max(0, min(ROWS - 1, int(row)))
        col = max(0, min(COLS - 1, int(col)))
        key = (row, col, round(float(scale), 4))
        cached = self._cache.get(key)
        if cached is not None:
            return cached

        sub = self._img.copy(col * FRAME_W, row * FRAME_H, FRAME_W, FRAME_H)
        pm = QPixmap.fromImage(sub)
        tw = max(1, round(FRAME_W * scale))
        th = max(1, round(FRAME_H * scale))
        pm = pm.scaled(
            tw,
            th,
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        self._cache[key] = pm
        return pm
