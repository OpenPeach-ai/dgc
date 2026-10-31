"""Render the selected Pip computer wallpaper for its desktop and editor preview.

    python scripts/make_pip_wallpaper.py <folder>

The source is pip-computer-graphite.svg. The three output sizes are deterministic.
This development-only renderer needs CairoSVG and Pillow; neither is a DGC runtime
dependency. Use the release-checked JPGs in dgc/desktop_assets and editors/vscode/media.
"""
from io import BytesIO
from pathlib import Path
import sys

import cairosvg
from PIL import Image


def main(dest):
    source = Path(__file__).with_name("pip-computer-graphite.svg")
    output = Path(dest)
    output.mkdir(parents=True, exist_ok=True)
    pixels = cairosvg.svg2png(url=str(source), output_width=1600, output_height=1000)
    image = Image.open(BytesIO(pixels)).convert("RGB")
    image.save(output / "wallpaper.jpg", quality=90, optimize=True, progressive=True)
    image.resize((1280, 800), Image.Resampling.LANCZOS).save(
        output / "wallpaper-1280.jpg", quality=88, optimize=True, progressive=True
    )
    image.resize((800, 500), Image.Resampling.LANCZOS).save(output / "preview.png")


if __name__ == "__main__":
    main(sys.argv[1])
