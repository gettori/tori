---
summary: file glyphs now resolve one of eleven hue names against the theme instead of 406 hardcoded hex values from VS Code
status: current
updated: 2026-07-24
source: "Seti file-type icons (personal/tori, branch code-mirror-6); retinted: Native theming system: palette + roles generator (branch `terminal-editor-design`) Phase 5, commit 809cbdc"
---

# Seti file-type icons

**Location:** `src/seti/` (`FileIcon.tsx`, `mapping.ts`), `scripts/gen-seti.mjs`, `scripts/vs-seti-icon-theme.json`, `public/seti.woff`

A file-type icon system vendored from VS Code's MIT `theme-seti`. A single `<FileIcon name>` renders a Private-Use-Area glyph from the bundled `seti.woff` webfont, tinted with a **theme-resolved hue** (the VS Code look preserved: `.ts` blue, `.json` yellow, …), in front of file names across the file tree, both editor-tab render paths, and quick-open. The icons share one 16px leading column so every row aligns.

## Responsibilities

- Map a bare file name to a `{ glyph, color }` `SetiIcon`: `iconFor(name)` tries exact `fileNames`, then longest compound extension, then last extension, then `defaultIcon` (`src/seti/FileIcon.tsx`).
- Ship a committed, generated lookup `src/seti/mapping.ts` (`{ fileNames, extensions, defaultIcon }`; glyphs are PUA chars, `color` is seti's dark-variant `fontColor`) built offline by `scripts/gen-seti.mjs` from `scripts/vs-seti-icon-theme.json`. The script is a regenerate tool, not wired into the build.
- Apply seti's per-type color via an inline `style.color`; the icon is `aria-hidden` since the filename text carries the meaning.
- Boundaries — does NOT do **folder icons** (folders keep a `▸/▾` chevron sized to match the icons; seti has no folder/open-folder glyph, see [[gotcha_seti_ships_no_folder_or_open_folder_glyph]]), per-type colors, the sidebar tree, terminal tabs, or any runtime JSON parsing.

## Key files & entry points

- `src/seti/FileIcon.tsx` — `iconFor(name)` resolution order; `FileIcon` (a `.seti-icon` PUA span with inline `color`).
- `src/seti/mapping.ts` — generated `SetiIcon` maps: `fileNames` / `extensions` / `defaultIcon`.
- `scripts/gen-seti.mjs` — codegen: the curated `EXT_TO_LANG` bridge, folds `languageIds` + `fileExtensions` into one flat `extensions` map, resolves `\Exxxx` → `String.fromCodePoint`, carries `fontColor`.
- `src/App.css` — `@font-face seti`, `.seti-icon` (16px slot, 15px glyph), `.tree-twisty` (chevron at the same 15px), `.qo-item` flex.

## Connections

- Used by [[component_cm6_editor]] — the file tree, editor tabs, and quick-open it owns now render `<FileIcon>` (files only; folders keep the chevron).
- Editor-tab icons render in **both** render props of [[component_overflow_tab_bar]] (`renderTab` and `renderMenuItem`), so overflowed tabs in the `+N` dropdown keep their icon.

## Related

- [[gotcha_seti_fileextensions_omits_mainstream_types]] — why a curated ext→languageId bridge is required.
- [[gotcha_seti_ships_no_folder_or_open_folder_glyph]] — why folders use a chevron, not a seti glyph.

## The icons follow the theme (hue names, not hexes)

`mapping.ts` used to carry 406 hex literals, all of them VS Code's *dark* variant, which is why the file tree stayed dark-coloured under a light theme. Those 406 entries draw on only **11 distinct hues**, so `gen-seti.mjs` now emits a hue **name** (`blue`, `yellow`, `graphite`, …) and `FileIcon` builds `var(--scale-<hue>)`, resolved from the active palette's `scale.*` roles by [[component_theme_engine]].

- **An unrecognised upstream hex is a hard error**, not a fallback to `silver`. Falling back would silently lose a colour the icon set considers meaningful; the generator throws and names the three places a new hue has to be added.
- **Removing the guard's allowlist entry for the generated file exposed a blind spot.** With `mapping.ts` scanned, check 1 flagged the hue names themselves, since 8 of the 11 (`red`, `green`, `blue`, `yellow`, `orange`, `purple`, `pink`, `silver`) are real CSS colours. The exemption is scoped to three axes at once: the generated file, the two positions the generator emits, and the declared scale names.
- **`FileIcon` builds its var name at runtime**, which check 3 can only be told to trust; guard check 6 is what earns that trust, asserting that the mapping's hue set and the `scale.*` roles name exactly the same eleven.
- All 11 hues must stay **distinct within a palette**. Two of the ports had a hue quietly collapsed onto its neighbour to clear the contrast gate, which renders two file types identically; both were fixed to muted greys instead.
