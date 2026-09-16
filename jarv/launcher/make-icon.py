#!/usr/bin/env python3
"""JARV app icon — generated from the brand, not hand-drawn, so it can be
rebuilt or tweaked at any time.

    python3 jarv/launcher/make-icon.py                  # → jarv/launcher/assets/
    python3 jarv/launcher/make-icon.py --wordmark       # add the JARV wordmark
    python3 jarv/launcher/make-icon.py --both           # plain + wordmark
    python3 jarv/launcher/make-icon.py --out /tmp/icon

Design: the brand's own terminal prompt — a chunky green chevron and cursor —
on the JARV navy squircle with the blue rim light. The palette is sampled from
the icon JARV already shipped, so it is the same brand, just properly built:

    navy   #182946  bg      blue  #649FF8  rim / rim-light
    green  #99E1A4  prompt  white #FFFFFF  wordmark

macOS draws app icons on Apple's grid: the shape fills 824 of a 1024 canvas and
the corners are *continuous* (a superellipse, not a plain rounded rect). So the
drawing pass runs at a 3x supersample and every size in the .icns is resampled
down from that one master — 16px stays legible, 512px stays clean.
"""
import argparse
import functools
import io
import math
import os
import shutil
import struct
import subprocess
import sys

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, "assets")

MASTER = 1024          # the canvas macOS expects for an icon master
SS = 3                 # supersample factor for the (hard-edged) drawing pass
WORK = 1024            # resolution for the smooth numpy layers

NAVY_TOP = (0x25, 0x3E, 0x68)
NAVY_BOTTOM = (0x0E, 0x17, 0x28)
RIM = (0x64, 0x9F, 0xF8)
PROMPT_HI = (0xD6, 0xF8, 0xDB)
PROMPT_LO = (0x79, 0xD0, 0x8F)
CORE_GLOW = (0x4A, 0xA8, 0x62)
WORDMARK_HI = (0xFF, 0xFF, 0xFF)
WORDMARK_LO = (0xC6, 0xD4, 0xEA)

GRID = 100.0 / MASTER       # Apple's grid: 100px of margin around 824 content
CORNER = 0.225              # corner radius ≈ 22.5% of the content box
SQUIRCLE_P = 5.0            # superellipse exponent ≈ Apple's continuous corner
RIM_W = 0.036               # rim stroke (half of it shows inside the shape)

# glyph geometry, in 1024-space
STROKE = 84                 # chevron stroke
CHEV_D = 210                # arm length; arms at exactly 45°
CHEV_X, CHEV_Y = 320, 500
UNDER = (596, 674, 770, 752)  # cursor: x0, y0, x1, y1
UNDER_R = 26

THIN = Image.Resampling.LANCZOS


# ─ geometry ─────────────────────────────────────────────────────────────────

def squircle(cx, cy, a, b, n=SQUIRCLE_P, steps=8192):
    """Continuous-corner rounded rect (superellipse |x/a|^n + |y/b|^n = 1)."""
    pts = []
    for i in range(steps):
        t = 2.0 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        pts.append((cx + a * math.copysign(abs(ct) ** (2.0 / n), ct),
                    cy + b * math.copysign(abs(st) ** (2.0 / n), st)))
    return pts


def body_box(size):
    """The squircle's centre and half-extents for a canvas of `size`."""
    part = size * (1.0 - 2.0 * GRID)
    return size / 2.0, size / 2.0, part / 2.0, part / 2.0


def body_mask(size):
    cx, cy, a, b = body_box(size)
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).polygon(squircle(cx, cy, a, b), fill=255)
    return m


def chevron_pts():
    """The chevron: two arms meeting at exactly 45°, in master space."""
    return [(CHEV_X, CHEV_Y - CHEV_D),
            (CHEV_X + CHEV_D, CHEV_Y),
            (CHEV_X, CHEV_Y + CHEV_D)]


def glyph_bbox():
    """Analytic bounds of the prompt glyph, so it can be optically centred."""
    xs = (CHEV_X - STROKE / 2.0, CHEV_X + CHEV_D + STROKE / 2.0,
          UNDER[0] - UNDER_R / 2.0, UNDER[2] + UNDER_R / 2.0)
    ys = (CHEV_Y - CHEV_D - STROKE / 2.0, CHEV_Y + CHEV_D + STROKE / 2.0,
          UNDER[1], UNDER[3])
    return min(xs), min(ys), max(xs), max(ys)


GLYPH_CY = 470.0            # optical centre of the glyph on its own
LOCKUP_CY = 496.0           # optical centre of the glyph + wordmark lockup
WORDMARK_W = 468.0          # ink width the wordmark is fitted to
WORDMARK_GAP = 92.0         # space between glyph and wordmark, in 1024-space
WORDMARK_Z = 0.84           # glyph shrink when the wordmark is baked in
WORDMARK_TEXT = "JARV"


def glyph_center():
    x0, y0, x1, y1 = glyph_bbox()
    return (x0 + x1) / 2.0, (y0 + y1) / 2.0


def lockup(wordmark=False):
    """(translate, zoom, wordmark ink top): shrink the glyph about its own
    centre, then place it — alone, or as the top half of the lockup. Derived
    rather than hand-tuned: change a glyph constant and the layout follows."""
    cx, cy = glyph_center()
    y0, y1 = glyph_bbox()[1], glyph_bbox()[3]
    if not wordmark:
        return (512.0 - cx, GLYPH_CY - cy), 1.0, None
    met = wordmark_metrics()
    ink_h = met[3] if met else 0.0
    gh = (y1 - y0) * WORDMARK_Z
    top = LOCKUP_CY - (gh + WORDMARK_GAP + ink_h) / 2.0
    return ((512.0 - cx, top + gh / 2.0 - cy), WORDMARK_Z, top + gh + WORDMARK_GAP)


def _place(pts, off, zoom, k):
    """Master-space points → canvas px, scaled about the glyph's centre."""
    cx, cy = glyph_center()
    return [(k * ((x - cx) * zoom + cx + off[0]),
             k * ((y - cy) * zoom + cy + off[1])) for x, y in pts]


def glyph_mask(size, off, zoom=1.0):
    """The prompt glyph: chunky chevron with round joins, plus the cursor."""
    k = size / float(MASTER)
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    pts = _place(chevron_pts(), off, zoom, k)
    w = max(1, int(round(STROKE * k * zoom)))
    d.line(pts, fill=255, width=w, joint="curve")
    r = w / 2.0
    for x, y in pts:                      # round caps + a redundant round joint
        d.ellipse([x - r, y - r, x + r, y + r], fill=255)
    x0, y0, x1, y1 = UNDER
    d.rounded_rectangle(_place([(x0, y0), (x1, y1)], off, zoom, k),
                        radius=max(1, int(round(UNDER_R * k * zoom))), fill=255)
    return m


# ─ layers ───────────────────────────────────────────────────────────────────
# The smooth layers (gradients, glow, rim) are computed on a small array and
# scaled up — a gradient has no detail to lose. Only the hard-edged glyph is
# drawn at SS× and filtered down, which is what keeps 16px legible.

PROBE = 512       # resolution for the numpy gradient / glow layers
TRACK = 0.055     # wordmark letter-spacing, as a fraction of the font size


def _vgrad(n, top, bottom):
    """A vertical two-stop gradient as an (n, n, 3) float array."""
    y = np.linspace(0.0, 1.0, n, dtype=np.float32)[:, None, None]
    arr = (np.array(top, np.float32)[None, None, :] * (1.0 - y)
           + np.array(bottom, np.float32)[None, None, :] * y)
    return np.repeat(arr, n, axis=1)


def _to_img(arr):
    return Image.fromarray(np.clip(arr, 0.0, 255.0).astype(np.uint8), "RGB")


def _fit(img, size):
    return img if img.size == (size, size) else img.resize((size, size), THIN)


def background(size):
    """Navy body: vertical gradient, plus a sheen from the top-left so the
    shape reads as lit from above rather than flat."""
    xx, yy = np.meshgrid(np.linspace(0.0, 1.0, PROBE, dtype=np.float32),
                         np.linspace(0.0, 1.0, PROBE, dtype=np.float32))
    sheen = (1.0 - (xx + yy) / 2.0)[..., None] * 30.0
    arr = _vgrad(PROBE, NAVY_TOP, NAVY_BOTTOM) + sheen
    return _fit(_to_img(arr), size)


def core_glow(size, center, radius, strength=0.62):
    """Soft green light behind the glyph — the 'engine is running' cue."""
    xs = np.linspace(0.0, 1.0, PROBE, dtype=np.float32)
    xx, yy = np.meshgrid(xs, xs)
    r = np.sqrt((xx - center[0]) ** 2 + (yy - center[1]) ** 2) / radius
    f = np.clip(1.0 - r, 0.0, 1.0) ** 2.4
    arr = (f * strength)[..., None] * np.array(CORE_GLOW, np.float32)[None, None, :]
    return _fit(_to_img(arr), size)


def rim_layer(size, inner_only=True):
    """Apple-style edge light: a blue stroke following the continuous corner,
    brighter along the top. Clipped to the body so only its inner half shows."""
    k = size / float(MASTER)
    w = max(1, int(round(RIM_W * MASTER * k)))
    m = Image.new("L", (size, size), 0)
    cx, cy, a, b = body_box(size)
    pts = squircle(cx, cy, a, b, steps=4096)
    ImageDraw.Draw(m).line(pts + [pts[0]], fill=255, width=w, joint="curve")
    if inner_only:
        m = ImageChops.multiply(m, body_mask(size))
    img = _fit(_to_img(_vgrad(256, RIM, tuple(c * 0.5 for c in RIM))), size)
    img = img.convert("RGBA")
    img.putalpha(m)
    return img


def glyph_layer(size, off, zoom=1.0):
    """The JARV prompt — chunky green chevron + cursor, in a light-to-dark
    gradient. Drawn at SS× and filtered once, so it stays crisp when small."""
    big = size * SS
    img = _fit(_to_img(_vgrad(256, PROMPT_HI, PROMPT_LO)), big).convert("RGBA")
    img.putalpha(glyph_mask(big, off, zoom))
    return _fit(img, size)


def glyph_shadow(size, off, zoom=1.0, dy=0.020, blur=0.028, alpha=120):
    """A soft shadow under the glyph, so it floats above the navy instead of
    sitting flat on it."""
    big = size * SS
    m = glyph_mask(big, off, zoom).filter(ImageFilter.GaussianBlur(blur * big))
    m = ImageChops.offset(_fit(m, size), 0, int(round(dy * size)))
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    img.putalpha(m.point(lambda v: int(v * alpha / 255.0)))
    return img


# ─ wordmark (opt-in) ────────────────────────────────────────────────────────
# Off by default: in the Dock the glyph alone reads faster. It is here for
# previews, splash art, or a Finder-friendly icon.
FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Arial Black.ttf",
    "/Library/Fonts/Arial Black.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Helvetica Bold.ttf",
    "/System/Library/Fonts/SFNS.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
)


def _font_path():
    return next((p for p in FONT_CANDIDATES if os.path.isfile(p)), None)


def _fit_font(text, target_w, track=TRACK):
    """The point size whose tracked rendering is exactly `target_w` wide."""
    path = _font_path()
    if not path:
        return None, 0.0
    probe = 400
    font = ImageFont.truetype(path, probe)
    width = sum(font.getlength(c) for c in text) + probe * track * (len(text) - 1)
    if width <= 0:
        return None, 0.0
    size = max(1, int(round(probe * target_w / width)))
    return ImageFont.truetype(path, size), size * track


@functools.lru_cache(maxsize=1)
def wordmark_metrics():
    """(font, track, ink_w, ink_h) for the wordmark in MASTER units.

    Measured, not assumed: "JARV" is caps with no descenders, so the rendered
    ink box *is* the cap height — which is what the lockup needs to place it.
    """
    font, track = _fit_font(WORDMARK_TEXT, WORDMARK_W)
    if font is None:
        return None
    probe = Image.new("L", (MASTER * 2, MASTER), 0)
    draw = ImageDraw.Draw(probe)
    x = 0.0
    for ch in WORDMARK_TEXT:
        draw.text((x, 400.0), ch, font=font, fill=255, anchor="ls")
        x += font.getlength(ch) + track
    ink = probe.getbbox()
    if ink is None:
        return None
    return font, track, float(ink[2] - ink[0]), float(ink[3] - ink[1])


def wordmark_layer(size, ink_top, alpha=250):
    """The name in letterspaced caps, drawn with its ink box placed exactly
    where `lockup()` said it goes."""
    k = size / float(MASTER)
    met = wordmark_metrics()
    if met is None:
        return None
    font, track, ink_w, _ink_h = met
    font = font.font_variant(size=max(1, int(round(font.size * k))))
    track *= k
    probe = Image.new("L", (size * 2, size * 2), 0)
    draw = ImageDraw.Draw(probe)
    x = 0.0
    for ch in WORDMARK_TEXT:
        draw.text((x, 0.0), ch, font=font, fill=255, anchor="la")
        x += font.getlength(ch) + track
    ink = probe.getbbox()
    mask = Image.new("L", (size, size), 0)
    mask.paste(probe.crop(ink),
               (int(round(512.0 * k - ink_w * k / 2.0)),
                int(round(ink_top * k))))
    img = _fit(_to_img(_vgrad(256, WORDMARK_HI, WORDMARK_LO)), size).convert("RGBA")
    img.putalpha(mask.point(lambda v: int(v * alpha / 255.0)))
    return img


# ─ compose ──────────────────────────────────────────────────────────────────

def render(size, wordmark=False, glow=True):
    """One icon at exactly `size` px, RGBA, on Apple's grid."""
    off, zoom, ink_top = lockup(wordmark)
    mask = body_mask(size)
    bg = background(size).convert("RGBA")
    if glow:
        cx, cy = glyph_center()
        centre = (cx + off[0]) / MASTER, (cy + off[1]) / MASTER
        bg = ImageChops.add(bg.convert("RGB"), core_glow(size, centre, 0.44)).convert("RGBA")
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(bg, (0, 0), mask)
    out.alpha_composite(rim_layer(size))
    out.alpha_composite(glyph_shadow(size, off, zoom))
    out.alpha_composite(glyph_layer(size, off, zoom))
    if wordmark:
        wm = wordmark_layer(size, ink_top)
        if wm is not None:
            out.alpha_composite(wm)
    # final silhouette: nothing may paint outside Apple's shape
    out.putalpha(ImageChops.multiply(out.split()[3], mask))
    return out


# ─ .icns ────────────────────────────────────────────────────────────────────
# A modern .icns is just a container of PNGs. iconutil is the sanctioned
# builder; the hand-rolled writer below keeps this script working on a machine
# without it, and makes the container format visible instead of magic.

ICONSET = (
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
)
ICNS_TYPES = (
    ("icp4", 16), ("icp5", 32), ("ic11", 32), ("ic12", 64), ("ic07", 128),
    ("ic13", 256), ("ic08", 256), ("ic14", 512), ("ic09", 512), ("ic10", 1024),
)


def _png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _draw_all(wordmark):
    """Every distinct size, rendered once and cached (each .icns entry is a
    duplicate pair — e.g. 32px is both icon_16x16@2x and icon_32x32)."""
    cache = {}
    for _name, size in ICONSET:
        if size not in cache:
            cache[size] = render(size, wordmark=wordmark)
    return cache


def build_icns(dest, wordmark=False, use_iconutil=True):
    """Write `dest` as an .icns and return its size in bytes."""
    cache = _draw_all(wordmark)
    if use_iconutil and shutil.which("iconutil"):
        iconset = dest + ".iconset"
        shutil.rmtree(iconset, ignore_errors=True)
        os.makedirs(iconset, exist_ok=True)
        try:
            for name, size in ICONSET:
                cache[size].save(os.path.join(iconset, name))
            subprocess.run(["iconutil", "-c", "icns", iconset, "-o", dest],
                           check=True, capture_output=True)
        finally:
            shutil.rmtree(iconset, ignore_errors=True)
        return os.path.getsize(dest)
    chunks = []
    for typ, size in ICNS_TYPES:
        if size not in cache:
            continue
        data = _png_bytes(cache[size])
        chunks.append(typ.encode("ascii") + struct.pack(">I", len(data) + 8) + data)
    body = b"".join(chunks)
    with open(dest, "wb") as fh:
        fh.write(b"icns" + struct.pack(">I", len(body) + 8) + body)
    return len(body) + 8


def contact_sheet(dest, wordmark=False, sizes=(16, 32, 64, 128, 256, 512)):
    """The real sizes side by side, on light and dark, so the small ones can
    actually be judged instead of admired at 1024 and hoped for at 16."""
    tiles = [(s, render(s, wordmark=wordmark)) for s in sizes]
    pad = 26
    width = sum(t.width for _s, t in tiles) + pad * (len(tiles) + 1)
    height = max(t.height for _s, t in tiles) + pad * 2
    sheet = Image.new("RGBA", (width, height), (0xF1, 0xF1, 0xF4, 255))
    ImageDraw.Draw(sheet).rectangle([width // 2, 0, width, height],
                                    fill=(0x1C, 0x1C, 0x20, 255))
    x = pad
    for _s, tile in tiles:
        sheet.alpha_composite(tile, (x, (height - tile.height) // 2))
        x += tile.width + pad
    sheet.save(dest)
    return sheet.size


# ─ cli ──────────────────────────────────────────────────────────────────────

def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="make-icon.py",
        description="Generate the JARV app icon (JARV.icns + preview PNGs).")
    ap.add_argument("--out", default=DEFAULT_OUT,
                    help="where to write (default: %(default)s)")
    ap.add_argument("--wordmark", action="store_true",
                    help="bake the JARV wordmark into the icon")
    ap.add_argument("--both", action="store_true",
                    help="write the plain icon and the wordmark icon")
    ap.add_argument("--no-iconutil", action="store_true",
                    help="assemble the .icns by hand instead of using iconutil")
    args = ap.parse_args(argv)

    if args.both:
        variants = [("JARV", False), ("JARV-wordmark", True)]
    elif args.wordmark:
        variants = [("JARV-wordmark", True)]
    else:
        variants = [("JARV", False)]
    os.makedirs(args.out, exist_ok=True)
    n_sizes = len({s for _n, s in ICONSET})
    for name, wordmark in variants:
        icns = os.path.join(args.out, name + ".icns")
        written = build_icns(icns, wordmark=wordmark,
                             use_iconutil=not args.no_iconutil)
        png = os.path.join(args.out, name.lower() + "-1024.png")
        render(MASTER, wordmark=wordmark).save(png)
        print(f"  {os.path.basename(icns):<22} {written:>9,} B · {n_sizes} sizes")
        print(f"  {os.path.basename(png):<22} preview master")
    sheet = os.path.join(args.out, "JARV-preview.png")
    contact_sheet(sheet, wordmark=(len(variants) == 1 and variants[0][1]))
    print(f"  {os.path.basename(sheet):<22} contact sheet (16 → 512 px)")
    print(f"\n  → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())