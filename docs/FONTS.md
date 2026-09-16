# Bundled terminal font

JetBrainsMono Nerd Font **Mono**, shipped so a prompt built out of Nerd Font
glyphs (powerline separators, devicons, file-type marks) renders the same on
every machine Tori runs on, whether or not the user has patched fonts installed.

| | |
|---|---|
| Upstream | [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts) 3.4.0, patching JetBrains Mono 2.304 |
| Internal family | `JetBrainsMono NFM`, typographic family `JetBrains Mono Nerd Font Mono` |
| Files | Regular, Bold, Italic, BoldItalic, 12,138 glyphs each, ~1.05 MB per style as woff2. Kept unsplit in `fonts-src/`; `public/fonts/` holds the range-split build that actually ships |
| License | SIL Open Font License 1.1, shipped alongside the fonts as `public/fonts/OFL.txt`. Unmodified, so no Reserved Font Name applies |

**The Mono variant, deliberately.** Nerd Fonts ships three widths, and the
plain "Nerd Font" build draws its icons at 1.5 cells. A terminal lays glyphs on
a fixed grid, so those icons overhang the next cell and the line stops lining
up. The `NFM` build fits every icon to one cell, which is what a grid needs.

## Split by unicode-range, never subset

A Nerd Font missing glyphs is the failure it exists to fix, so **nothing is
dropped**. Coverage in the browser is byte-for-byte what upstream ships.

What changed is how it is *delivered*. Each ~1 MB face is cut into five files by
codepoint range and declared five times in `src/styles/base.css`, each `@font-face`
carrying a `unicode-range`. The browser downloads a file only when it has to
render a codepoint inside that range. The motivation is that 89% of the weight is
icons nothing on screen usually asks for:

| Range | Codepoints | Per face | Fetched when |
|---|---|---|---|
| `text` U+0000-024F, U+2000-20CF | 409 | ~39 KB | always |
| `box` U+2500-28FF | 492 | ~9 KB | TUI frames, braille spinners (so, immediately) |
| `ext` U+0250-1FFF, U+2100-24FF, U+2900-2BFF, U+F900-FFFD | 669 | ~39 KB | Greek/Cyrillic, arrows, maths |
| `icons` U+E000-F8FF | 3,500 | ~485 KB | powerline separators, devicons |
| `icons-supp` U+10000-10FFFF | 6,942 | ~400 KB | Material Design icon glyphs |

That takes a cold start from decoding 1,020 KB before painting any text (the
`font-display: block` window) to roughly 48 KB.

## Regenerating

Only needed to move to a new Nerd Fonts release. The `.ttf` files come from the
upstream release (or `brew install --cask font-jetbrains-mono-nerd-font`, which
is where `public/fonts/OFL.txt` was taken from). Convert to woff2 into
`fonts-src/`, which holds the whole unsplit faces and is not shipped:

```sh
pip install fonttools brotli
python3 - <<'EOF'
from fontTools.ttLib import TTFont
import os
src = os.path.expanduser("~/Library/Fonts")
for style, slug in {"Regular": "regular", "Bold": "bold",
                    "Italic": "italic", "BoldItalic": "bold-italic"}.items():
    f = TTFont(f"{src}/JetBrainsMonoNerdFontMono-{style}.ttf")
    f.flavor = "woff2"
    f.save(f"fonts-src/jetbrains-mono-nerd-{slug}.woff2")
EOF
```

Then produce the shipped split into `public/fonts/`:

```sh
python3 scripts/subset-fonts.py
```

The script prints every range it wrote. If you change the ranges there, update
the matching `unicode-range` declarations in `src/styles/base.css`; a range in
the CSS that no file covers renders as tofu, and a file no CSS range points at is
simply never fetched.
