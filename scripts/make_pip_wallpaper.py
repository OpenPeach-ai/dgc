"""The DGC wallpaper for a Pip's computer: a violet night, aurora light, a silk wave, the DGC mark.

    python scripts/make_pip_wallpaper.py <folder>

writes wallpaper.jpg (1600x1000, the full desktop: dgc/desktop_assets/wallpaper.jpg) and
wallpaper-1280.jpg (the editor's drawn desktop: editors/vscode/media/pips/computer-wallpaper.jpg),
plus preview.png. Deterministic: the grain is seeded.
"""
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W, H = 2560, 1600
y, x = np.mgrid[0:H, 0:W].astype(np.float32)
u, v = x / W, y / H

def hexrgb(h):
    h = h.lstrip("#"); return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], np.float32)

# Base: deep violet, lighter towards the upper right.
top, bottom = hexrgb("#1a1040"), hexrgb("#0b0720")
t = np.clip(0.55 * v + 0.45 * (1 - u), 0, 1)[..., None]
img = top * (1 - t) + bottom * t

def glow(cx, cy, rx, ry, color, strength):
    d = ((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2
    a = np.exp(-d * 2.2)[..., None] * strength
    return a * hexrgb(color)

def screen(base, light):
    return 255 - (255 - base) * (255 - np.clip(light, 0, 255)) / 255

for cx, cy, rx, ry, col, s in [
    (0.86, 0.10, 0.55, 0.50, "#8b5cf6", 0.75),
    (0.62, 0.30, 0.35, 0.30, "#c084fc", 0.35),
    (0.10, 0.92, 0.55, 0.45, "#4f46e5", 0.55),
    (0.30, 0.55, 0.30, 0.25, "#7c3aed", 0.25),
    (0.95, 0.80, 0.30, 0.40, "#db2777", 0.18),
]:
    img = screen(img, glow(cx, cy, rx, ry, col, s))

# The silk: a few soft bands that follow one wave, brighter on its crest.
def band(phase, amp, center, width, color, strength):
    curve = center + amp * np.sin(2 * np.pi * (u * 0.9 + phase)) + 0.06 * np.sin(2 * np.pi * (u * 2.3 + phase * 1.7))
    d = (v - curve) / width
    a = np.exp(-d * d) * (0.35 + 0.65 * np.clip(1.2 - u, 0, 1))
    return (a * strength)[..., None] * hexrgb(color)

for phase, amp, center, width, col, s in [
    (0.08, 0.10, 0.62, 0.045, "#a78bfa", 0.55),
    (0.12, 0.11, 0.66, 0.020, "#ede9fe", 0.35),
    (0.02, 0.09, 0.70, 0.070, "#6d28d9", 0.45),
    (0.18, 0.12, 0.58, 0.012, "#ffffff", 0.22),
]:
    img = screen(img, band(phase, amp, center, width, col, s))

base = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")

# The DGC mark: three slanted bars from the logo (its 90x90 viewBox), big, glassy, glowing.
bars = [[(32, 24), (20, 30), (13, 72), (25, 66)], [(54, 18), (42, 24), (35, 72), (47, 66)], [(76, 24), (64, 30), (57, 66), (69, 60)]]
scale, ox, oy = 9.0, int(W * 0.635), int(H * 0.115)
pts = [[(ox + px * scale, oy + py * scale) for px, py in bar] for bar in bars]
glow_layer = Image.new("L", (W, H), 0)
gd = ImageDraw.Draw(glow_layer)
for p in pts:
    gd.polygon(p, fill=255)
halo = glow_layer.filter(ImageFilter.GaussianBlur(70))
halo_rgb = Image.new("RGB", (W, H), (167, 139, 250))
base = Image.composite(Image.blend(base, halo_rgb, 0.0), base, glow_layer.point(lambda a: 0))
base = Image.composite(halo_rgb, base, halo.point(lambda a: int(a * 0.65)))
# Glass fill: a vertical light gradient inside each bar.
fill = Image.new("RGB", (W, H))
fy = np.linspace(0, 1, H, dtype=np.float32)[:, None]
y0, y1 = (oy + 18 * scale) / H, (oy + 72 * scale) / H
k = np.clip((fy - y0) / (y1 - y0), 0, 1)
grad = (hexrgb("#f5f3ff")[None, None, :] * (1 - k[..., None]) + hexrgb("#8b5cf6")[None, None, :] * k[..., None])
fill = Image.fromarray(np.broadcast_to(grad, (H, W, 3)).astype(np.uint8), "RGB")
inner = glow_layer.filter(ImageFilter.GaussianBlur(1.2))
base = Image.composite(fill, base, inner.point(lambda a: int(a * 0.62)))
edge = glow_layer.filter(ImageFilter.FIND_EDGES).filter(ImageFilter.GaussianBlur(1.5))
base = Image.composite(Image.new("RGB", (W, H), (237, 233, 254)), base, edge.point(lambda a: min(255, int(a * 0.5))))

# Grain, so no gradient bands.
arr = np.asarray(base).astype(np.float32)
rng = np.random.default_rng(7)
arr += rng.normal(0, 2.2, arr.shape[:2])[..., None]
out = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")
dest = sys.argv[1]
out.resize((1600, 1000), Image.LANCZOS).save(dest + "/wallpaper.jpg", quality=88, optimize=True, progressive=True)
out.resize((1280, 800), Image.LANCZOS).save(dest + "/wallpaper-1280.jpg", quality=84, optimize=True, progressive=True)
out.resize((800, 500), Image.LANCZOS).save(dest + "/preview.png")
