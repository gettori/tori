---
summary: VS Code's theme-seti fileExtensions omits ts, js, json, md, css and py, which resolve via languageIds instead
status: current
updated: 2026-06-30
source: Seti file-type icons (personal/sway, branch code-mirror-6); `scripts/gen-seti.mjs` (`EXT_TO_LANG`)
---

# Seti fileExtensions omits mainstream types

Do NOT build a standalone Seti file-icon lookup from VS Code's `theme-seti` `fileExtensions` alone; `ts`/`js`/`json`/`md`/`css`/`py`/… are absent there and resolve through `languageIds`, so a `fileExtensions`-only port sends every common file to the default glyph. Why: VS Code maps extension→languageId via each language extension's contribution (not in the theme JSON), so the bridge must be supplied yourself. `scripts/gen-seti.mjs` keeps a curated `EXT_TO_LANG` table and folds `languageIds` into the flat `extensions` map at codegen time.
