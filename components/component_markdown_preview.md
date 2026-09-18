---
summary: markdown preview and image view bypass CodeEditor entirely since it reads every open file as utf8 text
status: current
updated: 2026-07-19
source: "v0.1 features: status indicators, search, input layer (personal/tori, branch `topbar`); Phase 3"
---

# Markdown preview + image view

**Location:** `src/panels/Editor/MarkdownPreview.tsx`, `src/panels/Editor/ImageView.tsx`, `src/utils/sanitizeHtml.ts`, `src/panels/Editor/CodeEditor.tsx`

A `.md` tab's Preview toggle, and an image view for image files opened from the tree. Both deliberately bypass [[component_cm6_editor]]'s `CodeEditor` rather than extending it, since `CodeEditor` reads every open path as UTF-8 text (`fs_read_file` + Rust's `read_to_string`), which errors/corrupts on binary image bytes.

## Responsibilities

- **`CodeEditor.tsx`'s `hidden` prop** (new): CSS `display:none`, not unmount — the same trick `TerminalView` uses to keep an inactive PTY alive. `Editor.tsx` sets it (plus `activePath={null}`) whenever the active tab is an image or has preview toggled on, so `CodeEditor`'s buffer map for every *other* open text file survives the swap untouched.
- **`MarkdownPreview.tsx`**: its own independent `fs_read_file` fetch (not reading `CodeEditor`'s live buffer — that's not exposed outside `CodeEditor.tsx`), rendered via `marked`, then passed through `sanitizeHtml` before `innerHTML`, then relative `<img>` src values resolved against the file's own directory via `convertFileSrc`.
- **`sanitizeHtml.ts`**: a hand-rolled allowlist walker (DOM-based, `DOMParser` + tree walk), not a `marked` option or a new dependency like DOMPurify. Strips `<script>`/`<style>`/`<iframe>`/`<object>`/`<embed>`/`<link>`/`<meta>`/`<base>`/`<form>` and any `on*` attribute or `javascript:`-scheme `href`/`src`. Necessary because local markdown (a plan doc, a README, an agent-written file) is untrusted as far as script execution goes once it's rendered into a Tauri webview that can call backend commands — `marked` does not sanitize by default.
- **`ImageView.tsx`**: `convertFileSrc(path)` into a plain `<img>`. `isImagePath` (exported) checks extension against a fixed set (png/jpg/jpeg/gif/webp/svg/bmp/ico/avif).
- **Asset protocol wiring**: `tauri.conf.json`'s `app.security.assetProtocol` needed `{enable: true, scope: ["**"]}` (no prior `convertFileSrc` usage anywhere in the codebase); `Cargo.toml`'s `tauri` dependency needed the `protocol-asset` feature, which `tauri-build` auto-added once the config declared it (not a manual edit).
- **Does NOT** keep the preview in sync with unsaved edits: since `MarkdownPreview` re-reads from disk independently, toggling to Preview on a file with unsaved changes in Source mode shows the last-*saved* version, not the in-progress edit. Documented limitation, not fixed — would need a real imperative API added to `CodeEditor` to expose its live buffer text to a parent.

## Key files & entry points

- `src/panels/Editor/CodeEditor.tsx` — the `hidden?: boolean` prop, applied to the root div's inline `style`.
- `src/panels/Editor/Editor.tsx` — `isImageTab()`/`isMarkdownTab()`/`showingPreview()`/`togglePreview()`, and the sibling `<Show>` blocks rendering `ImageView`/`MarkdownPreview` instead of (visually) `CodeEditor`.
- `src/utils/sanitizeHtml.ts` — `sanitizeHtml(html)`.
- `src/panels/Editor/MarkdownPreview.tsx` — `resolveImages`, the relative-src rewrite.
- `src-tauri/tauri.conf.json` — `app.security.assetProtocol`.

## Connections

- Sits inside [[component_cm6_editor]]'s tab system — extends `FileTab`'s handling with per-extension branching that didn't exist before this (previously every open file, regardless of type, flowed through one `CodeEditor` buffer unconditionally).
- Uses the same `hidden`-not-unmounted overlay pattern [[concept_workspace_tab_grouping]] established for terminal tabs.

## Related

- [[component_pdf_viewer]] - the third view bypassing `CodeEditor`'s text pipeline for the same reason, and the second reader of the asset protocol.
