#!/usr/bin/env python3
"""Split the JetBrains Mono Nerd faces into unicode-range subsets.

Why this exists
---------------
The upstream Nerd Font faces are ~1 MB each and we ship four of them. 89% of
that weight is icons: 3,500 codepoints in the private-use area and 6,942 in the
supplementary plane (Material Design Icons and friends). A terminal session that
prints plain text needs none of it, but `font-display: block` meant every cold
start blocked on decoding a megabyte before any text was painted.

This is a *lossless* split, not a lossy subset. Every glyph in the original is
still reachable; it is just distributed across several files, each tagged with a
`unicode-range` in `src/styles/base.css`. The browser fetches a file only when it
has to render a codepoint inside that range, so a normal session pays for the
Latin subset alone and the icon files stay on disk until something asks for them.

Regenerating
------------
Run after replacing anything in `fonts-src/`:

    pip install fonttools brotli
    python3 scripts/subset-fonts.py

Outputs land in `public/fonts/`. The `unicode-range` values in base.css must stay
in sync with SUBSETS below; the ranges are printed on every run so a change is
easy to copy across.
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "fonts-src"
OUT = ROOT / "public" / "fonts"

# Faces to process: (source stem, css suffix)
FACES = [
    "jetbrains-mono-nerd-regular",
    "jetbrains-mono-nerd-bold",
    "jetbrains-mono-nerd-italic",
    "jetbrains-mono-nerd-bold-italic",
]

# Order matters only for readability. Each entry is (name, unicode-range).
# `text` is the startup-critical one and is deliberately the smallest thing that
# can render ordinary terminal output.
SUBSETS = [
    ("text", "U+0000-024F,U+2000-20CF"),
    ("ext", "U+0250-1FFF,U+2100-24FF,U+2900-2BFF,U+F900-FFFD"),
    ("box", "U+2500-28FF"),
    ("icons", "U+E000-F8FF"),
    ("icons-supp", "U+10000-10FFFF"),
]


def main() -> int:
    if not SRC.is_dir():
        print(f"error: {SRC} not found (the unsubsetted originals live there)", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)

    total_src = 0
    total_out = 0
    for face in FACES:
        src = SRC / f"{face}.woff2"
        if not src.exists():
            print(f"error: missing {src}", file=sys.stderr)
            return 1
        total_src += src.stat().st_size
        print(f"\n{face}  ({src.stat().st_size / 1024:.0f} KB)")
        for name, urange in SUBSETS:
            dest = OUT / f"{face}-{name}.woff2"
            subprocess.run(
                [
                    sys.executable, "-m", "fontTools.subset", str(src),
                    f"--unicodes={urange}",
                    f"--output-file={dest}",
                    "--flavor=woff2",
                    # Keep every OpenType feature: JetBrains Mono ships
                    # programming ligatures and the editor renders them.
                    "--layout-features=*",
                    "--notdef-outline",
                    "--recommended-glyphs",
                ],
                check=True,
            )
            size = dest.stat().st_size
            total_out += size
            print(f"   {size / 1024:8.1f} KB  {dest.name}   {urange}")

    print(f"\noriginals: {total_src / 1024 / 1024:.2f} MB")
    print(f"subsets:   {total_out / 1024 / 1024:.2f} MB total on disk")
    startup = sum((OUT / f"{f}-text.woff2").stat().st_size for f in FACES)
    print(f"startup-critical (the four `text` subsets): {startup / 1024:.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
