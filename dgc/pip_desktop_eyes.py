"""A Pip's eyes and hands on its whole desktop (founder, 2026-10-20: "Pips use the whole desktop").

Beside the browser's own steps (text and refs, and its page by position: pip_eyes), a Pip whose model can see
gets the whole screen: a look at all of it, the mouse anywhere (click, double and right click, hover, a drag with
real moves, the wheel), typing into the window that has focus, keys and shortcuts, its open windows, bringing one
to the front, and opening the desktop's apps (pip_apps).

- **Hands** travel on the Pip's own connection to the desktop's VNC display (pip_rfb), never through the user's
  live view: the user's input stays theirs, marked as today (pip_screen.ClientFilter), and is dropped while a run
  is at the keyboard. **Windows** are read from the desktop's X server (pip_x11). Both use only the sockets in the
  computer's private runtime folder, never ``$DISPLAY``.
- **Eyes**: the screen is grabbed, and before anything is encoded DGC blacks out what the model must never see:
  on the browser's own tab every password, card number, expiry, security code and one-time code field (the same
  fields as the browser's own look: BoxedBrowser.secret_boxes), placed through the window the browser says it has
  and the one the X server shows; any other browser window, and the browser's window when another tab is showing
  in it, whole; and any window whose title says it asks for a password. When the browser's window can't be found
  on the screen, the picture is not sent. A password typed inside a desktop app's own window (not a dialog) is
  drawn as dots by the app; DGC can't find such a field by itself, which is the limit.
- The picture goes to the model as a JPEG of at most 1280x800, its size stated; after a step by position a red
  ring marks where the mouse is, as on the browser's look.
- **Writes stay held.** Every step marks the browser as acted on, so a submit or an upload a click on the
  browser's window causes waits for the user's Allow exactly as one from a browser step.

The desktop's apps and its Terminal are online through the computer's egress proxy (public websites only, never
this computer or its network) and send without an Allow card; only the browser holds what it would submit.

Linux only for now: on a Mac the screen is in the computer's VM, whose X server is not reachable from here.
"""
from __future__ import annotations

import re
import struct
import sys
import time
import zlib

from . import pip_rfb, pip_x11

DESKTOP_OPS = ("desktop_look", "desktop_click", "desktop_double_click", "desktop_right_click", "desktop_hover",
               "desktop_drag", "desktop_scroll", "desktop_type", "desktop_key", "windows", "focus_window", "launch_app")
DESKTOP_POINT_OPS = ("desktop_click", "desktop_double_click", "desktop_right_click", "desktop_hover", "desktop_drag",
                     "desktop_scroll")
# How the timeline and the live view (Pips API 53) draw a desktop step: the browser's own kinds, in the screen's pixels.
POINTER_KIND = {"desktop_click": "click_at", "desktop_double_click": "double_click_at",
                "desktop_right_click": "right_click_at", "desktop_hover": "hover_at", "desktop_drag": "drag",
                "desktop_scroll": "scroll_at"}
VERBS = {"desktop_click": "Clicked", "desktop_double_click": "Double-clicked", "desktop_right_click": "Right-clicked",
         "desktop_hover": "Moved the mouse", "desktop_drag": "Dragged", "desktop_scroll": "Scrolled"}
MAX_WIDTH, MAX_HEIGHT = 1280, 800
QUALITY = 70
FRAME_BYTES = 90 * 1024
MAX_TYPE = 2000
WHEEL_PIXELS = 40                         # one notch of the wheel, about three lines
PAD = 4                                   # pixels around a field that is blacked out
PLACE_SLACK = 12                          # how far the browser's and the X server's idea of its window may differ
BROWSER_CLASS = re.compile(r"chrom", re.I)
# A desktop app's window that asks for a secret, by its title ("Enter Password", "Unlock Keyring", "Authentication
# required"). Never a browser window: its fields are found one by one, and a page called "login" is not a dialog.
SECRET_TITLE = re.compile(r"\bpass(?:word|phrase|code)s?\b|\benter (?:the |your )?pin\b|\bunlock\b|\bauthenticat|"
                          r"\bsign in\b|\blog in\b|\bcredentials?\b|\bone-time code\b|\bverification code\b|"
                          r"\bsecurity code\b|\bcard number\b", re.I)


class DesktopError(Exception):
    """A step on the desktop that could not be done; the message is for the Pip."""


def supported() -> bool:
    return sys.platform.startswith("linux")


# --------------------------------------------------------------------------- the screen and its windows

def grab(desktop) -> tuple[int, int, bytearray]:
    try:
        with pip_rfb.Screen(desktop.vnc_socket) as screen:
            width, height, pixels = screen.grab()
    except OSError as error:
        raise DesktopError(f"the screen could not be read ({str(error)[:160]})") from error
    return width, height, bytearray(pixels)


def windows(desktop) -> list[dict]:
    try:
        with pip_x11.Display(pip_x11.socket_path(desktop.x11_dir)) as display:
            return display.windows()
    except OSError as error:
        raise DesktopError(f"the desktop's windows could not be read ({str(error)[:160]})") from error


def activate(desktop, window: int) -> None:
    try:
        with pip_x11.Display(pip_x11.socket_path(desktop.x11_dir)) as display:
            display.activate(window)
    except OSError as error:
        raise DesktopError(f"that window could not be brought to the front ({str(error)[:160]})") from error


def shown_windows(found: list[dict]) -> str:
    """The open windows, front first, as the Pip reads them."""
    rows = []
    for w in reversed([w for w in found if w["shown"]]):
        app = w["app"] or w["instance"] or "app"
        rows.append(f"{w['id']} {app}: {w['title'] or '(no title)'} at {w['x']},{w['y']} size {w['width']}x{w['height']}"
                    + (" (in front)" if w["active"] else ""))
    hidden = [w for w in found if not w["shown"]]
    if hidden:
        rows.append("minimised: " + ", ".join(f"{w['id']} {w['title'] or w['app']}" for w in hidden[:12]))
    return "\n".join(rows) if rows else "No windows are open."


# --------------------------------------------------------------------------- what is never shown

def _rect(x, y, w, h) -> tuple[int, int, int, int]:
    return int(x) - PAD, int(y) - PAD, int(w) + 2 * PAD, int(h) + 2 * PAD


def secret_regions(browser, found: list[dict]) -> dict[str, list[tuple[int, int, int, int]]]:
    """What must be blacked out before anyone but the user sees the screen, window by window: {window id: [(x, y,
    width, height) in the screen's pixels]}. Raises DesktopError when the browser's own window can't be placed: that
    picture is never sent. (black_out applies them in stacking order, so a window in front stays as it is.)"""
    regions: dict[str, list] = {}
    chrome = [w for w in found if w["shown"] and BROWSER_CLASS.search(f"{w['app']} {w['instance']}")]
    for w in found:
        if w["shown"] and w not in chrome and SECRET_TITLE.search(w["title"] or ""):
            regions.setdefault(w["id"], []).append(_rect(w["x"], w["y"], w["width"], w["height"]))  # a password dialog
    # The browser draws on this screen unless it runs headless (no desktop when it started): then it has no window here.
    alive = (browser is not None and browser.alive() and getattr(browser, "display_dir", None) is not None)
    if not chrome and not alive:
        return regions
    try:
        said = browser.desktop_secrets() if alive else None
    except Exception as error:             # noqa: BLE001 - a browser that can't say is never shown
        raise DesktopError("the browser's password and card fields could not be checked, so DGC did not show the "
                           f"screen ({str(error)[:120]})") from error
    placed = set()
    if said is not None:
        own = next((w for w in said["windows"] if w["own"]), None)
        for x in chrome:
            match = next((w for w in said["windows"] if w["state"] not in ("minimized",)
                          and abs(w["left"] - x["x"]) <= PLACE_SLACK and abs(w["top"] - x["y"]) <= PLACE_SLACK
                          and abs(w["width"] - x["width"]) <= PLACE_SLACK and abs(w["height"] - x["height"]) <= PLACE_SLACK), None)
            if match is None or not match["own"] or not said["visible"]:
                continue                     # another window, or another tab showing in it: whole, below
            ratio = said["ratio"] or 1.0
            inner_w, inner_h = said["inner"][0] * ratio, said["inner"][1] * ratio
            left = x["x"] + max(0.0, (x["width"] - inner_w) / 2)
            top = x["y"] + max(0.0, x["height"] - inner_h)
            for box in said["boxes"]:
                regions.setdefault(x["id"], []).append(_rect(left + box[0] * ratio, top + box[1] * ratio,
                                                             box[2] * ratio, box[3] * ratio))
            placed.add(x["id"])
        if own is not None and own["state"] not in ("minimized",) and said["visible"] and not placed:
            raise DesktopError("the browser's window could not be found on the screen, so its password and card fields "
                               "could not be blacked out; DGC did not show the screen. Use look for the browser's page.")
    for x in chrome:
        if x["id"] not in placed:
            regions.setdefault(x["id"], []).append(_rect(x["x"], x["y"], x["width"], x["height"]))  # whole: unseen inside
    return regions


def _clip(rect, width, height):
    x, y, w, h = rect
    left, top, right, bottom = max(0, x), max(0, y), min(width, x + w), min(height, y + h)
    return (left, top, right, bottom) if right > left and bottom > top else None


def black_out(pixels: bytearray, width: int, height: int, regions, found: list[dict] | None = None) -> int:
    """Black out ``regions`` ({window id: rects}, or a plain list of rects) in place. With the windows (bottom to
    top), each window's own regions are blacked out at its place in the stack, and every window in front of it is
    put back as it was: a browser window behind the image editor never blacks out the editor."""
    if not isinstance(regions, dict):
        regions = {"": list(regions)}
    original = bytes(pixels) if found else b""
    count, dirty = 0, False
    order = [w for w in (found or []) if w["shown"]]
    layers = [(w["id"], regions.get(w["id"], [])) for w in order] + [(key, rects) for key, rects in regions.items()
                                                                       if key not in {w["id"] for w in order}]
    for index, (key, rects) in enumerate(layers):
        if not rects:
            window = order[index] if index < len(order) else None
            if dirty and window is not None:
                left_f, right_f, top_f, bottom_f = (window.get("frame") or [0, 0, 0, 0])[:4]
                spot = _clip((window["x"] - left_f, window["y"] - top_f, window["width"] + left_f + right_f,
                              window["height"] + top_f + bottom_f), width, height)
                if spot is not None:                      # in front of something blacked out: as it really is
                    left, top, right, bottom = spot
                    for line in range(top, bottom):
                        start, end = (line * width + left) * 4, (line * width + right) * 4
                        pixels[start:end] = original[start:end]
            continue
        for rect in rects:
            spot = _clip(rect, width, height)
            if spot is None:
                continue
            left, top, right, bottom = spot
            count += 1
            dirty = True
            row = bytes(4 * (right - left))
            for line in range(top, bottom):
                start = (line * width + left) * 4
                pixels[start:start + len(row)] = row
    return count


def _dot(pixels, width, height, x, y, colour) -> None:
    if 0 <= x < width and 0 <= y < height:
        start = (y * width + x) * 4
        pixels[start:start + 3] = colour


def mark(pixels: bytearray, width: int, height: int, at: tuple[float, float], start: tuple[float, float] | None = None) -> None:
    """A red ring (white edged) where the mouse is, and a dashed line from where a drag began: DGC's, not the app's."""
    import math
    red, white = bytes((30, 30, 230)), bytes((255, 255, 255))      # blue, green, red order
    x0, y0 = at
    if start is not None:
        sx, sy = start
        steps = int(max(abs(x0 - sx), abs(y0 - sy)))
        for i in range(steps):
            if (i // 6) % 2 == 0:
                px, py = sx + (x0 - sx) * i / max(steps, 1), sy + (y0 - sy) * i / max(steps, 1)
                for dx in (0, 1):
                    _dot(pixels, width, height, int(px) + dx, int(py), red)
    cx, cy = int(round(x0)), int(round(y0))
    for py in range(cy - 13, cy + 14):
        for px in range(cx - 13, cx + 14):
            distance = math.hypot(px - x0, py - y0)
            if 7.5 <= distance <= 10.5:
                _dot(pixels, width, height, px, py, red)
            elif 6.0 <= distance < 7.5 or 10.5 < distance <= 12.5:
                _dot(pixels, width, height, px, py, white)


def png(width: int, height: int, pixels) -> bytes:
    """The screen as a PNG (stdlib only): blue-green-red-unused pixels in, red-green-blue rows out."""
    rgb = bytearray(width * height * 3)
    rgb[0::3] = pixels[2::4]
    rgb[1::3] = pixels[1::4]
    rgb[2::3] = pixels[0::4]
    stride = width * 3
    raw = b"".join(b"\0" + bytes(rgb[row * stride:(row + 1) * stride]) for row in range(height))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 3)) + chunk(b"IEND", b""))


def fitted(width: int, height: int, max_width: int = MAX_WIDTH, max_height: int = MAX_HEIGHT) -> tuple[int, int, float]:
    fit = min(1.0, max_width / width, max_height / height)
    return max(1, round(width * fit)), max(1, round(height * fit)), fit


def jpeg(picture: bytes, width: int, height: int, *, quality: int = QUALITY, browser=None,
         max_width: int = MAX_WIDTH, max_height: int = MAX_HEIGHT) -> tuple[bytes, int, int]:
    """A JPEG of an already blacked-out PNG, fitted to max_width x max_height: with this computer's own image tools
    (photos), or, with none, the Pip's browser, in DGC's isolated world."""
    from . import image_views, photos
    out_w, out_h, fit = fitted(width, height, max_width, max_height)
    side = None if fit >= 1.0 else max(out_w, out_h)
    made = None
    try:
        made = photos._convert(picture, ".png", "jpeg", side, quality, heic=False)
    except photos.PhotoError:
        made = None
    if made is None and browser is not None and browser.alive():
        import base64
        from .pip_computer_box import _COMPOSE_JS
        done = browser._in_world(browser._isolated(), _COMPOSE_JS, base64.b64encode(picture).decode("ascii"), [],
                                 out_w, out_h, fit, quality / 100, None, "image/png", timeout=30)
        if isinstance(done, dict) and isinstance(done.get("data"), str):
            made = base64.b64decode(done["data"])
    if not made:
        raise DesktopError("this computer has nothing to make a picture of the screen with (install ffmpeg)")
    size = image_views.parse_dimensions(made[:256 * 1024])
    if not size:
        raise DesktopError("the picture of the screen could not be made")
    return made, int(size[0]), int(size[1])


def shot(desktop, browser, *, pointer: dict | None = None, quality: int = QUALITY,
         max_width: int = MAX_WIDTH, max_height: int = MAX_HEIGHT) -> dict:
    """The whole screen as the model sees it: {data, width, height, scale, masked, windows}. ``scale`` is picture
    pixels per screen pixel. Never returns a picture whose secrets could not be blacked out."""
    found = windows(desktop)
    regions = secret_regions(browser, found)
    width, height, pixels = grab(desktop)
    masked = black_out(pixels, width, height, regions, found)
    if pointer is not None:
        start = (pointer["from_x"], pointer["from_y"]) if "from_x" in pointer else None
        mark(pixels, width, height, (pointer["x"], pointer["y"]), start)
    data, out_w, out_h = jpeg(png(width, height, pixels), width, height, quality=quality, browser=browser,
                              max_width=max_width, max_height=max_height)
    return {"data": data, "width": out_w, "height": out_h, "scale": out_w / width, "masked": masked,
            "windows": found, "screen": (width, height)}


def frame(desktop, browser, pointer: dict | None = None) -> tuple[bytes, float] | None:
    """A timeline picture of the screen (blacked out the same way), small enough to keep: (JPEG, scale) or None."""
    for side, quality in ((MAX_WIDTH, 55), (960, 50), (800, 40)):
        try:
            made = shot(desktop, browser, pointer=pointer, quality=quality, max_width=side, max_height=side * 5 // 8)
        except DesktopError:
            return None
        if len(made["data"]) <= FRAME_BYTES:
            return made["data"], made["scale"]
    return None


# --------------------------------------------------------------------------- the hands

def point(args: dict, key_x: str, key_y: str, scale: float, screen: tuple[int, int]) -> tuple[float, float]:
    """A point the model named in the latest picture of the screen, as the screen's pixels."""
    x, y = args.get(key_x), args.get(key_y)
    if (isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (int, float)) or not isinstance(y, (int, float))
            or x != x or y != y):
        raise DesktopError(f"give the point as numbers {key_x} and {key_y}")
    shown_w, shown_h = round(screen[0] * scale), round(screen[1] * scale)
    if not (0 <= x <= shown_w and 0 <= y <= shown_h):
        raise DesktopError(f"({x:g}, {y:g}) is off the screen, which is {shown_w}x{shown_h} pixels")
    return min(float(x) / scale, screen[0] - 1), min(float(y) / scale, screen[1] - 1)


def act(desktop, op: str, args: dict, scale: float, screen: tuple[int, int]) -> tuple[str, dict | None]:
    """One step of the hands: what was done in a few words, and where the mouse is (screen pixels) when it moved."""
    try:
        with pip_rfb.Screen(desktop.vnc_socket) as hands:
            if op == "desktop_type":
                text = args.get("text")
                if not isinstance(text, str) or not text:
                    raise DesktopError("give the text to type")
                if len(text) > MAX_TYPE:
                    raise DesktopError(f"type at most {MAX_TYPE} characters at a time")
                hands.type_text(text)
                return f"Typed {len(text)} characters into the window in front.", None
            if op == "desktop_key":
                key = str(args.get("key") or "")
                try:
                    hands.press(key)
                except ValueError as error:
                    raise DesktopError(str(error)) from None
                return f"Pressed {key}.", None
            x, y = point(args, "x", "y", scale, screen)
            pointer = {"kind": POINTER_KIND[op], "x": round(x, 1), "y": round(y, 1)}
            shown = f"{args.get('x'):g}, {args.get('y'):g}"
            if op == "desktop_drag":
                to_x, to_y = point(args, "to_x", "to_y", scale, screen)
                hands.drag(x, y, to_x, to_y)
                pointer.update(from_x=pointer["x"], from_y=pointer["y"], x=round(to_x, 1), y=round(to_y, 1))
                return f"Dragged from {shown} to {args.get('to_x'):g}, {args.get('to_y'):g}.", pointer
            if op == "desktop_scroll":
                dy, dx = args.get("dy", 0), args.get("dx", 0)
                if (isinstance(dy, bool) or not isinstance(dy, (int, float)) or dy != dy
                        or isinstance(dx, bool) or not isinstance(dx, (int, float)) or dx != dx or not (dy or dx)):
                    raise DesktopError("give dy, the pixels to scroll (negative is up)")
                notches = lambda v: (1 if v > 0 else -1) * max(1, round(abs(float(v)) / scale / WHEEL_PIXELS)) if v else 0
                hands.scroll(x, y, notches(dy))
                hands.scroll(x, y, notches(dx), sideways=True)
                return f"Scrolled {'down' if dy >= 0 else 'up'} at {shown}.", pointer
            if op == "desktop_hover":
                hands.move(x, y)
                return f"Moved the mouse to {shown}.", pointer
            button, count = ("right", 1) if op == "desktop_right_click" else ("left", 2 if op == "desktop_double_click" else 1)
            hands.click(x, y, button=button, count=count)
            return f"{VERBS[op]} at {shown}.", pointer
    except pip_rfb.RFBError as error:
        raise DesktopError(str(error)) from error
    except OSError as error:
        raise DesktopError(f"the screen did not take that ({str(error)[:160]})") from error


def _window_under(found: list[dict], x: float, y: float) -> dict | None:
    for w in reversed(found):
        if w["shown"] and w["x"] <= x < w["x"] + w["width"] and w["y"] <= y < w["y"] + w["height"]:
            return w
    return None


def _browser(window: dict | None) -> bool:
    return window is not None and bool(BROWSER_CLASS.search(f"{window['app']} {window['instance']}"))


def on_browser(found: list[dict], op: str, args: dict, scale: float) -> bool:
    """Whether a step lands on the browser's window: keys and typing go to the window in front; the mouse to the
    window under it (either end of a drag). When DGC can't tell, it is taken as on the browser."""
    if op in ("desktop_type", "desktop_key"):
        front = next((w for w in found if w["active"]), None)
        return front is None or _browser(front)
    points = [("x", "y")] + ([("to_x", "to_y")] if op == "desktop_drag" else [])
    for kx, ky in points:
        x, y = args.get(kx), args.get(ky)
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)) or not scale:
            return True
        if _browser(_window_under(found, float(x) / scale, float(y) / scale)):
            return True
    return False


def drawn(pixels: bytes, width: int, rect) -> bool:
    """Whether a window has drawn its contents yet: a few distinct colours across it, not one flat fill."""
    x, y, w, h = rect
    seen = set()
    for row in range(8):
        for col in range(8):
            px, py = int(x + w * (col + 0.5) / 8), int(y + h * (row + 0.5) / 8)
            start = (py * width + px) * 4
            seen.add(bytes(pixels[start:start + 3]))
    return len(seen) >= 4


def wait_for_window(desktop, before: set, *, seconds: float = 30) -> bool:
    """After opening an app: wait for a new window, then for it to draw (an app's first start can take a while)."""
    deadline = time.monotonic() + seconds
    appeared = None
    while time.monotonic() < deadline:
        time.sleep(0.4)
        fresh = [w for w in windows(desktop) if w["id"] not in before and w["shown"] and w["width"] > 40 and w["height"] > 40]
        if not fresh:
            continue
        appeared = appeared or time.monotonic()
        width, height, pixels = grab(desktop)
        w = max(fresh, key=lambda f: f["width"] * f["height"])
        rect = (max(0, w["x"]), max(0, w["y"]), min(w["width"], width - max(0, w["x"])), min(w["height"], height - max(0, w["y"])))
        # Drawn, or there long enough to be a plain window (an empty PDF viewer is mostly one colour).
        if rect[2] > 8 and rect[3] > 8 and drawn(pixels, width, rect) or time.monotonic() - appeared > 8:
            time.sleep(0.6)
            return True
    return appeared is not None


def window_at(found: list[dict], x: float, y: float) -> str:
    """The window under a point, front first, in a few words."""
    for w in reversed(found):
        if w["shown"] and w["x"] <= x < w["x"] + w["width"] and w["y"] <= y < w["y"] + w["height"]:
            return w["title"] or w["app"] or "a window"
    return "the desktop"
