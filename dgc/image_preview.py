"""A small picture of an image for the terminal: rows of half-block cells ("▀"), each with a top and a bottom colour.

PNG is decoded here with the standard library alone (8- and 16-bit grey, RGB, palette, with or without alpha; not
interlaced), which is what ComfyUI, Automatic1111 and most providers send. A JPEG or WebP gets a picture only when
Pillow happens to be installed; otherwise the terminal shows the path, as it always does.
"""
from __future__ import annotations

import struct
import zlib

MAX_PIXELS = 4096 * 4096


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def decode_png(data: bytes):
    """(width, height, rows of RGB tuples) of a PNG, or None for one this decoder doesn't read."""
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        return None
    pos, idat, palette, header = 8, [], None, None
    while pos + 8 <= len(data):
        length, kind = struct.unpack("!I4s", data[pos:pos + 8])
        if pos + 12 + length > len(data):
            return None
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            if len(body) != 13 or header is not None:
                return None
            header = struct.unpack("!IIBBBBB", body)
        elif kind == b"PLTE":
            palette = [tuple(body[i:i + 3]) for i in range(0, len(body) - 2, 3)]
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            break
    if header is None:
        return None
    width, height, depth, color, _comp, _filter, interlace = header
    if not width or not height or interlace or depth not in (8, 16) or width * height > MAX_PIXELS:
        return None
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color)
    if channels is None or (color == 3 and (not palette or depth != 8)):
        return None
    step = channels * (depth // 8)
    stride = width * step
    expected = (stride + 1) * height
    try:
        inflater = zlib.decompressobj()
        raw = inflater.decompress(b"".join(idat), expected + 1)
    except zlib.error:
        return None
    if len(raw) != expected or not inflater.eof or inflater.unconsumed_tail or inflater.unused_data:
        return None
    rows = []
    previous = bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        kind, line = raw[start], bytearray(raw[start + 1:start + 1 + stride])
        if kind > 4:
            return None
        if kind == 1:
            for i in range(step, stride):
                line[i] = (line[i] + line[i - step]) & 0xFF
        elif kind == 2:
            line = bytearray((a + b) & 0xFF for a, b in zip(line, previous))
        elif kind == 3:
            for i in range(stride):
                left = line[i - step] if i >= step else 0
                line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xFF
        elif kind == 4:
            for i in range(stride):
                left = line[i - step] if i >= step else 0
                up_left = previous[i - step] if i >= step else 0
                line[i] = (line[i] + _paeth(left, previous[i], up_left)) & 0xFF
        rows.append(line)
        previous = line

    def pixel(x: int, y: int) -> tuple[int, int, int]:
        line = rows[y]
        at = x * step
        if depth == 16:
            values = [line[at + 2 * k] for k in range(channels)]
        else:
            values = list(line[at:at + channels])
        if color == 3:
            return palette[values[0]] if values[0] < len(palette) else (0, 0, 0)
        if color in (0, 4):
            grey = values[0]
            rgb = (grey, grey, grey)
        else:
            rgb = tuple(values[:3])
        if color in (4, 6):                          # alpha over the terminal's own dark background
            alpha = values[-1] / 255
            rgb = tuple(int(v * alpha + 24 * (1 - alpha)) for v in rgb)
        return rgb
    return width, height, pixel


def _pillow(data: bytes):
    try:
        import io
        from PIL import Image                      # optional: never a DGC dependency
    except ImportError:
        return None
    try:
        image = Image.open(io.BytesIO(data))
        if not image.width or not image.height or image.width * image.height > MAX_PIXELS:
            return None
        image = image.convert("RGB")
    except Exception:                              # noqa: BLE001 -- no picture, the path still shows
        return None
    width, height = image.size
    load = image.load()
    return width, height, lambda x, y: load[x, y]


def cells(data: bytes, columns: int = 24, *, max_rows: int = 14):
    """Rows of (top, bottom) "#rrggbb" pairs, ``columns`` wide at most, or None when DGC can't draw it."""
    decoded = decode_png(data) if data.startswith(b"\x89PNG\r\n\x1a\n") else _pillow(data)
    if decoded is None:
        return None
    width, height, pixel = decoded
    columns = max(4, min(columns, width))
    # A terminal cell is about twice as tall as it is wide: two pixel rows a cell, one column a cell.
    rows = max(1, min(max_rows, round(columns * height / width / 2)))
    if rows == max_rows:
        columns = max(4, min(columns, round(rows * 2 * width / height)))
    out = []
    for row in range(rows):
        line = []
        for col in range(columns):
            x = min(width - 1, int((col + 0.5) * width / columns))
            top = pixel(x, min(height - 1, int((row * 2 + 0.5) * height / (rows * 2))))
            bottom = pixel(x, min(height - 1, int((row * 2 + 1.5) * height / (rows * 2))))
            line.append(("#%02x%02x%02x" % tuple(top), "#%02x%02x%02x" % tuple(bottom)))
        out.append(line)
    return out


def ansi(rows) -> str:
    """The same picture as 24-bit colour escapes, for the classic terminal."""
    lines = []
    for row in rows or []:
        parts = []
        for top, bottom in row:
            t = tuple(int(top[i:i + 2], 16) for i in (1, 3, 5))
            b = tuple(int(bottom[i:i + 2], 16) for i in (1, 3, 5))
            parts.append(f"\x1b[38;2;{t[0]};{t[1]};{t[2]}m\x1b[48;2;{b[0]};{b[1]};{b[2]}m▀")
        lines.append("".join(parts) + "\x1b[0m")
    return "\n".join(lines)
