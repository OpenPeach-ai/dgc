"""Build the body-only tint mask from the existing eight-character plush atlas.

The mask is a local build asset. Accessories remain the original atlas pixels;
only the coloured fabric inside this mask receives a chosen body tint.
Run from the repository root with Pillow installed.
"""
from __future__ import annotations

import colorsys
from pathlib import Path

from PIL import Image, ImageFilter


ATLAS = Path("editors/vscode/media/pips/plush-bodies.webp")
OUTPUT = Path("editors/vscode/media/pips/plush-body-mask.png")
HUES = (272, 143, 213, 24, 228, 44, 178, 348)
TOLERANCES = (43, 43, 39, 20, 38, 31, 40, 31)


def build() -> None:
    source = Image.open(ATLAS).convert("RGBA")
    if source.size != (3320, 1896):
        raise ValueError("The plush atlas changed; inspect its characters before rebuilding the mask.")
    result = Image.new("L", source.size)
    pixels, mask = source.load(), result.load()
    for y in range(source.height):
        for x in range(source.width):
            red, green, blue, alpha = pixels[x, y]
            if alpha < 20:
                continue
            character = (y // 948) * 4 + x // 830
            hue, saturation, value = colorsys.rgb_to_hsv(red / 255, green / 255, blue / 255)
            distance = abs((hue * 360 - HUES[character] + 180) % 360 - 180)
            # Rook's dark beret and Pulse's clock retain their original materials.
            clock = character == 5 and ((x - 1450) / 115) ** 2 + ((y - 1510) / 115) ** 2 < 1
            if (distance < TOLERANCES[character] and saturation > .16
                    and (character != 4 or value > .42) and not clock):
                mask[x, y] = alpha
    result.filter(ImageFilter.GaussianBlur(.6)).save(OUTPUT, optimize=True)


if __name__ == "__main__":
    build()
