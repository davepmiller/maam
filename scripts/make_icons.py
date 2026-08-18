#!/usr/bin/env python3
"""Generate the app icons. Standard library only -- writes PNGs by hand.

The mark is the page's own signature element: the locality spread, where faint
ticks are every state's rate and the brass one is yours. Drawn at 4x and boxed
down, so the edges stay clean without an imaging library.

    python3 scripts/make_icons.py
"""

import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                 # icons ship from the root, next to index.html

GROUND = (0x12, 0x16, 0x1B, 255)   # --ground, dark
RAIL   = (0x2C, 0x35, 0x3F, 255)   # --line
TICK   = (0x68, 0x72, 0x7E, 255)   # --faint
BRASS  = (0xF0, 0xB9, 0x5B, 255)   # --signal

SS = 4                              # supersample factor

# where the faint ticks sit, as a fraction of the plot width, and which one is us
TICKS = [0.00, 0.09, 0.16, 0.27, 0.34, 0.46, 0.53, 0.61, 0.78, 0.88, 1.00]
MINE = 0.695


def write_png(path, px, w, h):
    raw = bytearray()
    for y in range(h):
        raw.append(0)                                   # filter type 0
        row = px[y * w:(y + 1) * w]
        for p in row:
            raw += bytes(p)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(png)


def render(size, maskable):
    """Draw at SS resolution, then average each SSxSS block down."""
    S = size * SS
    px = [(0, 0, 0, 0)] * (S * S)

    inset = 0.14 if maskable else 0.0        # keep art inside the maskable safe zone
    radius = 0 if maskable else int(S * 0.22)

    def fill_rect(x0, y0, x1, y1, color):
        for y in range(max(0, int(y0)), min(S, int(y1))):
            base = y * S
            for x in range(max(0, int(x0)), min(S, int(x1))):
                px[base + x] = color

    # ground, with rounded corners unless the OS will mask it
    for y in range(S):
        base = y * S
        for x in range(S):
            if radius:
                cx = min(max(x, radius), S - radius)
                cy = min(max(y, radius), S - radius)
                if (x - cx) ** 2 + (y - cy) ** 2 > radius * radius:
                    continue
            px[base + x] = GROUND

    pad = S * (0.20 + inset)
    plot_w = S - 2 * pad
    baseline = S * (1 - (0.30 + inset))
    tick_h = S * 0.20
    rail_h = max(1, S * 0.014)

    fill_rect(pad, baseline, pad + plot_w, baseline + rail_h, RAIL)

    tw = max(1, S * 0.026)
    for t in TICKS:
        x = pad + plot_w * t
        fill_rect(x - tw / 2, baseline - tick_h, x + tw / 2, baseline, TICK)

    # ours: taller, brass, with the marker dot above it
    mw = max(1, S * 0.045)
    mx = pad + plot_w * MINE
    mh = tick_h * 1.85
    fill_rect(mx - mw / 2, baseline - mh, mx + mw / 2, baseline + rail_h, BRASS)

    r = S * 0.075
    cy = baseline - mh - r * 0.55
    for y in range(int(cy - r), int(cy + r) + 1):
        if not (0 <= y < S):
            continue
        base = y * S
        for x in range(int(mx - r), int(mx + r) + 1):
            if 0 <= x < S and (x - mx) ** 2 + (y - cy) ** 2 <= r * r:
                px[base + x] = BRASS

    # box downsample
    out = []
    for y in range(size):
        for x in range(size):
            r_ = g_ = b_ = a_ = 0
            for dy in range(SS):
                row = (y * SS + dy) * S + x * SS
                for dx in range(SS):
                    p = px[row + dx]
                    a = p[3]
                    r_ += p[0] * a; g_ += p[1] * a; b_ += p[2] * a; a_ += a
            n = SS * SS
            if a_:
                out.append((r_ // a_, g_ // a_, b_ // a_, a_ // n))
            else:
                out.append((0, 0, 0, 0))
    return out


def main():
    for size, maskable, name in [
        (32,  False, "icon-32.png"),
        (180, False, "icon-180.png"),
        (192, False, "icon-192.png"),
        (512, False, "icon-512.png"),
        (512, True,  "icon-maskable-512.png"),
    ]:
        path = os.path.join(ROOT, name)
        write_png(path, render(size, maskable), size, size)
        print("wrote {:<24} {:>7} bytes".format(name, os.path.getsize(path)))


if __name__ == "__main__":
    main()
