---
summary: vs code's seti theme has no folder or open folder glyph, tori draws folders with a sized chevron instead
status: current
updated: 2026-06-30
source: Seti file-type icons (personal/tori, branch code-mirror-6); `src/components/FileTree.tsx`, `src/App.css` (`.tree-twisty`)
---

# Seti ships no folder or open-folder glyph

Do NOT try to render folders with a Seti folder icon: VS Code's `theme-seti` JSON has no `folder`/`folderExpanded` keys (it uses a chevron), and while the `seti.woff` font does contain a closed-folder glyph at `U+E032`, there is **no** open/expanded variant, so you cannot show expand state by swapping it. Why: seti was built for file-type-by-extension icons, not tree affordances. Tori keeps a `▸/▾` chevron for folders, sized (`font-size:15px`, 16px box) to match the seti file glyphs.
