"""多栋 —— 桌面比格犬桌宠

动画来自 pets/duodong/spritesheet.webp（8 列 x 9 行，单帧 192x208），
对话走 config.json 里配置的 SiliconFlow 接口。
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

from PySide6.QtCore import QPoint, QRect, Qt, QTimer, Signal
from PySide6.QtGui import (
    QAction,
    QColor,
    QFont,
    QFontMetrics,
    QPainter,
    QPainterPath,
    QPixmap,
)
from PySide6.QtWidgets import (
    QApplication,
    QFrame,
    QGraphicsDropShadowEffect,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMenu,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from ai import ChatWorker
from sprites import FRAME_H, FRAME_W, SpriteSheet

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.json"
EXAMPLE_PATH = ROOT / "config.example.json"

DEFAULT_CONFIG: dict = {
    "api": {
        "base_url": "https://api.siliconflow.cn/v1",
        "api_key": "",
        "model": "deepseek-ai/DeepSeek-V4.1-Flash",
        "temperature": 0.85,
        "max_tokens": 512,
        "timeout_s": 120,
    },
    "pet": {
        "spritesheet": "pets/duodong/spritesheet.webp",
        "scale": 0.85,
        "frame_interval_ms": 110,
        "speed_px": 3,
        "wander": True,
        "wander_delay_s": [14, 34],
        "walk_duration_s": [2.0, 5.0],
        "idle_emote_chance": 0.45,
        "bubble_timeout_s": 12,
        "start_position": "bottom-right",
        "margin_px": 48,
    },
    "anims": {
        "idle": {"row": 0, "frames": 6},
        "walk_r": {"row": 1, "frames": 8},
        "walk_l": {"row": 2, "frames": 8},
        "wave": {"row": 3, "frames": 4},
        "talk": {"row": 4, "frames": 5},
        "cry": {"row": 5, "frames": 8},
        "shake": {"row": 6, "frames": 6},
        "chew": {"row": 7, "frames": 6},
        "happy": {"row": 8, "frames": 6},
    },
    "persona": "你是桌宠「多栋」，一只懒洋洋但很黏人的比格犬。回答简短口语化，60 字以内，不要 Markdown。",
}


def _merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = value
    return out


def load_config() -> dict:
    path = CONFIG_PATH if CONFIG_PATH.exists() else EXAMPLE_PATH
    if not path.exists():
        return dict(DEFAULT_CONFIG)
    with open(path, encoding="utf-8") as fh:
        return _merge(DEFAULT_CONFIG, json.load(fh))


# --------------------------------------------------------------------------- #
# 对话气泡
# --------------------------------------------------------------------------- #
class SpeechBubble(QWidget):
    PAD = 13
    TAIL = 9
    MAX_W = 320

    def __init__(self) -> None:
        super().__init__(
            None,
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.WindowDoesNotAcceptFocus,
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)

        self._label = QLabel(self)
        self._label.setWordWrap(True)
        self._label.setTextFormat(Qt.TextFormat.PlainText)
        self._label.setFont(QFont("Microsoft YaHei UI", 10))
        self._label.setStyleSheet("color:#F2F2F4; background:transparent;")
        self._label.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)

        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.timeout.connect(self.hide)
        self.hide()

    def paintEvent(self, _event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        body = QRect(0, 0, self.width(), self.height() - self.TAIL)

        path = QPainterPath()
        path.addRoundedRect(float(body.x()), float(body.y()), float(body.width()), float(body.height()), 13, 13)

        tail = QPainterPath()
        cx = self.width() / 2
        tail.moveTo(cx - 8, body.bottom() - 1)
        tail.lineTo(cx, self.height() - 1)
        tail.lineTo(cx + 8, body.bottom() - 1)
        tail.closeSubpath()
        path = path.united(tail)

        painter.setPen(QColor(255, 255, 255, 38))
        painter.setBrush(QColor(20, 22, 27, 238))
        painter.drawPath(path)

    def show_text(self, text: str, anchor: QRect, timeout_ms: int = 12000) -> None:
        text = (text or "").strip()
        if not text:
            self.hide()
            return
        self._layout_for(text)
        self._place(anchor)
        self.show()
        self.raise_()
        self._timer.start(max(1200, timeout_ms))

    def _layout_for(self, text: str) -> None:
        self._label.setText(text)
        metrics: QFontMetrics = self._label.fontMetrics()
        rect = metrics.boundingRect(
            QRect(0, 0, self.MAX_W, 10000),
            int(Qt.TextFlag.TextWordWrap),
            text,
        )
        inner_w = max(60, min(self.MAX_W, rect.width()))
        inner_h = max(metrics.height(), rect.height())
        width = inner_w + self.PAD * 2
        height = inner_h + self.PAD * 2
        self._label.setGeometry(self.PAD, self.PAD, inner_w, inner_h)
        self.setFixedSize(width, height + self.TAIL)

    def _place(self, anchor: QRect) -> None:
        screen = self.screen().availableGeometry() if self.screen() else QApplication.primaryScreen().availableGeometry()
        x = anchor.center().x() - self.width() // 2
        y = anchor.top() - self.height() - 4
        if y < screen.top():
            y = screen.top() + 4
        x = max(screen.left() + 4, min(x, screen.right() - self.width() - 4))
        self.move(x, y)

    def mousePressEvent(self, _event) -> None:
        self.hide()


# --------------------------------------------------------------------------- #
# 聊天面板
# --------------------------------------------------------------------------- #
class ChatPanel(QWidget):
    submitted = Signal(str)

    def __init__(self) -> None:
        super().__init__(
            None,
            Qt.WindowType.FramelessWindowHint | Qt.WindowType.Tool,
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setFixedSize(392, 300)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(12, 12, 12, 12)

        card = QFrame(self)
        card.setObjectName("card")
        outer.addWidget(card)

        shadow = QGraphicsDropShadowEffect(self)
        shadow.setBlurRadius(28)
        shadow.setOffset(0, 6)
        shadow.setColor(QColor(0, 0, 0, 170))
        card.setGraphicsEffect(shadow)

        layout = QVBoxLayout(card)
        layout.setContentsMargins(14, 12, 14, 12)
        layout.setSpacing(9)

        title = QLabel("多栋 · DeepSeek-V4.1-Flash", card)
        title.setObjectName("title")
        layout.addWidget(title)

        self.transcript = QTextEdit(card)
        self.transcript.setReadOnly(True)
        self.transcript.setObjectName("transcript")
        layout.addWidget(self.transcript, 1)

        row = QHBoxLayout()
        row.setSpacing(8)
        self.input = QLineEdit(card)
        self.input.setPlaceholderText("跟多栋说点什么…（Enter 发送）")
        row.addWidget(self.input, 1)
        self.send_btn = QPushButton("发送", card)
        self.send_btn.setFixedWidth(62)
        row.addWidget(self.send_btn)
        layout.addLayout(row)

        self.setStyleSheet(
            """
            QFrame#card {
                background: rgba(20, 22, 27, 242);
                border: 1px solid rgba(255, 255, 255, 34);
                border-radius: 16px;
            }
            QLabel#title {
                color: #9FB4CF;
                font-size: 11px;
                letter-spacing: 0.5px;
                background: transparent;
            }
            QTextEdit#transcript {
                background: transparent;
                border: none;
                color: #E6E8EC;
                font-size: 13px;
                selection-background-color: rgba(90,150,255,120);
            }
            QLineEdit {
                background: rgba(255, 255, 255, 20);
                border: 1px solid rgba(255, 255, 255, 40);
                border-radius: 9px;
                padding: 8px 11px;
                color: #F4F4F6;
                font-size: 13px;
            }
            QLineEdit:focus { border: 1px solid rgba(120, 180, 255, 170); }
            QPushButton {
                background: rgba(86, 146, 255, 235);
                color: #FFFFFF;
                border: none;
                border-radius: 9px;
                padding: 8px 12px;
                font-size: 13px;
            }
            QPushButton:hover { background: rgba(112, 168, 255, 255); }
            QPushButton:disabled { background: rgba(90, 100, 120, 160); }
            """
        )

        self.send_btn.clicked.connect(self._submit)
        self.input.returnPressed.connect(self._submit)

    def _submit(self) -> None:
        text = self.input.text().strip()
        if not text:
            return
        self.input.clear()
        self.submitted.emit(text)

    def append(self, who: str, text: str) -> None:
        color = {"你": "#8FD0FF", "多栋": "#FFCF7A"}.get(who, "#FF8C8C")
        safe = (
            text.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\n", "<br>")
        )
        self.transcript.append(
            f'<div style="margin:6px 0;"><span style="color:{color};font-weight:600;">{who}</span>'
            f'<span style="color:#B9BEC7;">：</span>'
            f'<span style="color:#E6E8EC;">{safe}</span></div>'
        )
        bar = self.transcript.verticalScrollBar()
        bar.setValue(bar.maximum())

    def show_near(self, pet_rect: QRect) -> None:
        screen = QApplication.primaryScreen().availableGeometry()
        x = pet_rect.center().x() - self.width() // 2
        y = pet_rect.top() - self.height() - 10
        if y < screen.top() + 8:
            y = pet_rect.bottom() + 10
        x = max(screen.left() + 8, min(x, screen.right() - self.width() - 8))
        y = max(screen.top() + 8, min(y, screen.bottom() - self.height() - 8))
        self.move(x, y)
        self.show()
        self.raise_()
        self.activateWindow()
        self.input.setFocus()

    def keyPressEvent(self, event) -> None:
        if event.key() == Qt.Key.Key_Escape:
            self.hide()
            return
        super().keyPressEvent(event)


# --------------------------------------------------------------------------- #
# 桌宠主体
# --------------------------------------------------------------------------- #
class PetWindow(QWidget):
    def __init__(self, cfg: dict, sheet: SpriteSheet) -> None:
        super().__init__(
            None,
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool,
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self.setWindowTitle("多栋")
        self.setCursor(Qt.CursorShape.OpenHandCursor)

        self.cfg = cfg
        self.sheet = sheet
        pet_cfg = cfg["pet"]
        self.anims: dict = cfg["anims"]
        self.persona: str = cfg.get("persona", "")
        self.scale = float(pet_cfg["scale"])
        self.speed = int(pet_cfg["speed_px"])
        self.bubble_timeout = int(float(pet_cfg["bubble_timeout_s"]) * 1000)
        self.wander_enabled = bool(pet_cfg["wander"])

        self.setFixedSize(round(FRAME_W * self.scale), round(FRAME_H * self.scale))

        self.anim = "idle"
        self.frame_i = 0
        self._loops_left: int | None = None
        self._next_anim = "idle"
        self._walk_dir = 1

        self._press_pos: QPoint | None = None
        self._win_pos = QPoint(0, 0)
        self._drag_moved = False
        self._walking_until: QTimer | None = None

        self.history: list[dict] = []
        self._acc = ""
        self.worker: ChatWorker | None = None

        self.bubble = SpeechBubble()
        self.panel = ChatPanel()
        self.panel.submitted.connect(self.ask)

        self.timer = QTimer(self)
        self.timer.timeout.connect(self._tick)
        self.timer.start(int(pet_cfg["frame_interval_ms"]))

        self._flush = QTimer(self)
        self._flush.setSingleShot(True)
        self._flush.timeout.connect(self._flush_bubble)

        self._place_initially(pet_cfg)
        self._schedule_idle_event()

    # ---------------- 位置 ----------------
    def _place_initially(self, pet_cfg: dict) -> None:
        screen = QApplication.primaryScreen().availableGeometry()
        margin = int(pet_cfg.get("margin_px", 48))
        pos = str(pet_cfg.get("start_position", "bottom-right"))
        if pos == "bottom-left":
            x, y = screen.left() + margin, screen.bottom() - self.height() - margin
        elif pos == "center":
            x = screen.center().x() - self.width() // 2
            y = screen.bottom() - self.height() - margin
        else:
            x, y = screen.right() - self.width() - margin, screen.bottom() - self.height() - margin
        self.move(int(x), int(y))

    def _clamp_into_screen(self) -> None:
        screen = QApplication.primaryScreen().availableGeometry()
        x = max(screen.left(), min(self.x(), screen.right() - self.width()))
        y = max(screen.top(), min(self.y(), screen.bottom() - self.height()))
        self.move(x, y)

    # ---------------- 动画 ----------------
    def _play(self, name: str, loops: int | None = None, then: str = "idle") -> None:
        if name not in self.anims:
            name = "idle"
        self.anim = name
        self.frame_i = 0
        self._loops_left = loops
        self._next_anim = then
        self.update()

    def _tick(self) -> None:
        frames = max(1, int(self.anims[self.anim]["frames"]))
        self.frame_i += 1
        if self.frame_i >= frames:
            if self._loops_left is None:
                self.frame_i = 0
            else:
                self._loops_left -= 1
                if self._loops_left <= 0:
                    self._play(self._next_anim)
                    return
                self.frame_i = 0
        if self.anim in ("walk_r", "walk_l"):
            self._step()
        self.update()

    def _step(self) -> None:
        screen = QApplication.primaryScreen().availableGeometry()
        nx = self.x() + (self.speed if self._walk_dir > 0 else -self.speed)
        if nx <= screen.left():
            nx = screen.left()
            self._walk_dir = 1
            self._play("walk_r")
            return
        if nx >= screen.right() - self.width():
            nx = screen.right() - self.width()
            self._walk_dir = -1
            self._play("walk_l")
            return
        self.move(nx, self.y())

    def paintEvent(self, _event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
        spec = self.anims[self.anim]
        frames = max(1, int(spec["frames"]))
        pm: QPixmap = self.sheet.frame(int(spec["row"]), self.frame_i % frames, self.scale)
        painter.drawPixmap(0, 0, pm)

    # ---------------- 自主行为 ----------------
    def _schedule_idle_event(self) -> None:
        if not self.wander_enabled:
            return
        lo, hi = self.cfg["pet"]["wander_delay_s"]
        delay = random.uniform(float(lo), float(hi)) * 1000
        QTimer.singleShot(int(delay), self._idle_event)

    def _idle_event(self) -> None:
        self._schedule_idle_event()
        if self.anim != "idle" or (self.worker and self.worker.isRunning()):
            return
        if random.random() < 0.45:
            self._start_wander()
        else:
            chance = float(self.cfg["pet"]["idle_emote_chance"])
            if random.random() < chance:
                emote = random.choice(["wave", "shake", "chew", "happy"])
                self._play(emote, loops=random.randint(1, 2))

    def _start_wander(self) -> None:
        screen = QApplication.primaryScreen().availableGeometry()
        room_left = self.x() - screen.left()
        room_right = screen.right() - self.width() - self.x()
        self._walk_dir = 1 if room_right >= room_left else -1
        self._play("walk_r" if self._walk_dir > 0 else "walk_l")
        lo, hi = self.cfg["pet"]["walk_duration_s"]
        duration = random.uniform(float(lo), float(hi)) * 1000
        if self._walking_until is not None:
            self._walking_until.stop()
        self._walking_until = QTimer(self)
        self._walking_until.setSingleShot(True)
        self._walking_until.timeout.connect(self._stop_wander)
        self._walking_until.start(int(duration))

    def _stop_wander(self) -> None:
        if self.anim in ("walk_r", "walk_l"):
            self._play("idle")

    # ---------------- 对话 ----------------
    def toggle_chat(self) -> None:
        if self.panel.isVisible():
            self.panel.hide()
        else:
            self.panel.show_near(self.geometry())

    def ask(self, text: str) -> None:
        text = (text or "").strip()
        if not text:
            return
        if self.worker and self.worker.isRunning():
            self.bubble.show_text("我还在想上一个问题呢，等我一下嘛", self.geometry(), 3500)
            return

        self.history.append({"role": "user", "content": text})
        self.panel.append("你", text)
        self._acc = ""
        self._play("talk")

        messages = [{"role": "system", "content": self.persona}] + self.history[-12:]
        self.worker = ChatWorker(self.cfg, messages, self)
        self.worker.thinking.connect(self._on_thinking)
        self.worker.delta.connect(self._on_delta)
        self.worker.finished_ok.connect(self._on_reply)
        self.worker.failed.connect(self._on_error)
        self.worker.start()

    def _on_thinking(self) -> None:
        self.bubble.show_text("让我想想…", self.geometry(), 20000)

    def _on_delta(self, _piece: str) -> None:
        self._acc += _piece
        if not self._flush.isActive():
            self._flush.start(110)

    def _flush_bubble(self) -> None:
        if self._acc.strip():
            self.bubble.show_text(self._acc + "▍", self.geometry(), 20000)

    def _on_reply(self, text: str) -> None:
        self._flush.stop()
        text = text.strip() or "……（我好像没想出词）"
        self.history.append({"role": "assistant", "content": text})
        if len(self.history) > 24:
            self.history = self.history[-24:]
        self.panel.append("多栋", text)
        self.bubble.show_text(text, self.geometry(), self.bubble_timeout)
        self._play("idle")

    def _on_error(self, message: str) -> None:
        self._flush.stop()
        self.panel.append("系统", message)
        self.bubble.show_text(f"呜…我脑子抽风了：{message}", self.geometry(), 8000)
        self._play("cry", loops=2)

    # ---------------- 鼠标 ----------------
    def mousePressEvent(self, event) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            self._press_pos = event.globalPosition().toPoint()
            self._win_pos = self.pos()
            self._drag_moved = False
            self.setCursor(Qt.CursorShape.ClosedHandCursor)

    def mouseMoveEvent(self, event) -> None:
        if self._press_pos is None or not (event.buttons() & Qt.MouseButton.LeftButton):
            return
        delta = event.globalPosition().toPoint() - self._press_pos
        if delta.manhattanLength() > 4:
            self._drag_moved = True
        if self._drag_moved:
            self.move(self._win_pos + delta)

    def mouseReleaseEvent(self, event) -> None:
        if event.button() != Qt.MouseButton.LeftButton:
            return
        self.setCursor(Qt.CursorShape.OpenHandCursor)
        self._press_pos = None
        if self._drag_moved:
            self._clamp_into_screen()
            self._play("idle")
        else:
            self.toggle_chat()

    def contextMenuEvent(self, event) -> None:
        menu = QMenu(self)
        menu.setStyleSheet(
            """
            QMenu {
                background: #17191E;
                color: #E6E8EC;
                border: 1px solid rgba(255,255,255,40);
                border-radius: 8px;
                padding: 6px;
                font-size: 13px;
            }
            QMenu::item { padding: 6px 22px 6px 14px; border-radius: 6px; }
            QMenu::item:selected { background: rgba(86,146,255,200); }
            QMenu::separator { height: 1px; background: rgba(255,255,255,30); margin: 5px 8px; }
            """
        )

        act_chat = QAction("跟我聊聊", menu)
        act_chat.triggered.connect(self.toggle_chat)
        menu.addAction(act_chat)

        act_walk = QAction("自己溜达一圈", menu)
        act_walk.triggered.connect(self._start_wander)
        menu.addAction(act_walk)

        menu.addSeparator()

        act_wander = QAction("自动漫步", menu)
        act_wander.setCheckable(True)
        act_wander.setChecked(self.wander_enabled)
        act_wander.toggled.connect(self._toggle_wander)
        menu.addAction(act_wander)

        act_reload = QAction("重新载入配置", menu)
        act_reload.triggered.connect(self._reload_config)
        menu.addAction(act_reload)

        menu.addSeparator()
        act_quit = QAction("退出", menu)
        act_quit.triggered.connect(QApplication.instance().quit)
        menu.addAction(act_quit)

        menu.exec(event.globalPos())
        event.accept()

    def _toggle_wander(self, enabled: bool) -> None:
        self.wander_enabled = enabled
        if enabled:
            self._schedule_idle_event()
        else:
            self._stop_wander()

    def _reload_config(self) -> None:
        try:
            self.cfg = load_config()
            self.anims = self.cfg["anims"]
            self.persona = self.cfg.get("persona", "")
            self.bubble.show_text("配置已重新载入 ✓", self.geometry(), 2500)
        except Exception as exc:  # noqa: BLE001
            self.bubble.show_text(f"配置有错：{exc}", self.geometry(), 6000)

    def closeEvent(self, event) -> None:
        if self.worker and self.worker.isRunning():
            self.worker.stop()
            self.worker.wait(1200)
        self.bubble.close()
        self.panel.close()
        event.accept()


# --------------------------------------------------------------------------- #
def _selftest(pet: PetWindow) -> None:
    """无交互自检：渲染若干状态并截图，供人工核对。"""
    out = ROOT / ".workbuddy" / "tmp"
    out.mkdir(parents=True, exist_ok=True)

    canvas = QPixmap(pet.width() * 3 + 40, pet.height() * 3 + 80)
    canvas.fill(QColor(38, 40, 46))
    painter = QPainter(canvas)
    shots = [("idle", 0), ("walk_r", 3), ("wave", 1), ("talk", 2), ("cry", 3), ("chew", 2)]
    for idx, (name, frame) in enumerate(shots):
        pet.anim = name
        pet.frame_i = frame
        pm = QPixmap(pet.size())
        pm.fill(Qt.GlobalColor.transparent)
        pet.render(pm)
        col, row = idx % 3, idx // 3
        painter.drawPixmap(10 + col * (pet.width() + 10), 10 + row * (pet.height() + 10), pm)
    painter.end()
    canvas.save(str(out / "pet_states.png"))

    pet.bubble.show_text("我是多栋，接的是 DeepSeek-V4.1-Flash，点我就能聊天～", pet.geometry(), 60000)
    QApplication.processEvents()
    bubble_img = QPixmap(pet.bubble.size())
    bubble_img.fill(QColor(52, 55, 62))
    painter = QPainter(bubble_img)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    pet.bubble.render(painter, QPoint(0, 0))
    painter.end()
    bubble_img.save(str(out / "bubble.png"))

    print(f"[selftest] 窗口 {pet.width()}x{pet.height()}  动画 {len(pet.anims)} 个")
    print(f"[selftest] 截图 -> {out / 'pet_states.png'} / bubble.png")


def main() -> int:
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)

    cfg = load_config()
    sheet_path = ROOT / cfg["pet"]["spritesheet"]
    try:
        sheet = SpriteSheet(sheet_path)
    except Exception as exc:  # noqa: BLE001
        print(f"精灵图加载失败: {exc}", file=sys.stderr)
        return 2

    pet = PetWindow(cfg, sheet)
    pet.show()

    if "--selftest" in sys.argv:
        _selftest(pet)
        return 0

    pet.bubble.show_text("嗨，我又回来啦～", pet.geometry(), 4000)
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
