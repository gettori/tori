---
summary: a VS Code theme's colors block carries chrome only, so reading just colors renders the editor monochrome
status: current
updated: 2026-07-24
source: CM6 migration (personal/tori); commit c69e2ef; superseded by branch `terminal-editor-design` Phase 2; _2026-06-29, retired 2026-07-24_
---

# VS Code theme `colors` cannot color syntax (historical)

**No longer live in Tori**: VS Code theme import was removed entirely, and syntax comes from the palette's 20 authored `syn*` primitives ([[component_theme_engine]]). Kept because the trap generalises to anything that reads a VS Code theme. Do NOT expect a theme's `colors` block to drive syntax highlighting; `colors` carries chrome only, and token colours live in a separate `tokenColors` array, so a distiller that reads only `colors` renders the editor monochrome.
