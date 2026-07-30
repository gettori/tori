# Bundled terminal font

JetBrainsMono Nerd Font **Mono**, shipped so a prompt built out of Nerd Font
glyphs (powerline separators, devicons, file-type marks) renders the same on
every machine Sway runs on, whether or not the user has patched fonts installed.

| | |
|---|---|
| Upstream | [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts) 3.4.0, patching JetBrains Mono 2.304 |
| Internal family | `JetBrainsMono NFM`, typographic family `JetBrains Mono Nerd Font Mono` |
| Files | Regular, Bold, Italic, BoldItalic, 12,138 glyphs each, ~1.05 MB per style as woff2 |
| License | SIL Open Font License 1.1, shipped alongside the fonts as `public/fonts/OFL.txt`. Unmodified, so no Reserved Font Name applies |

**The Mono variant, deliberately.** Nerd Fonts ships three widths, and the
plain "Nerd Font" build draws its icons at 1.5 cells. A terminal lays glyphs on
a fixed grid, so those icons overhang the next cell and the line stops lining
up. The `NFM` build fits every icon to one cell, which is what a grid needs.

## Regenerating

Only needed to move to a new Nerd Fonts release. The `.ttf` files come from the
upstream release (or `brew install --cask font-jetbrains-mono-nerd-font`, which
is where `public/fonts/OFL.txt` was taken from); the conversion is plain fontTools with no
subsetting, since a Nerd Font missing glyphs is the failure it exists to fix:

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
    f.save(f"public/fonts/jetbrains-mono-nerd-{slug}.woff2")
EOF
```

The `@font-face` rules that load these live in `src/styles/base.css`.
