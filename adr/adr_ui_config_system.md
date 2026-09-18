---
summary: UI config gets two tier design tokens, an importable VS Code theme engine and JSONC settings, replacing App.css
status: current
updated: 2026-08-05
source: "plan \"Central configurable UI system\" (2026-07-13), branch `code-mirror-6`. Anchors: `src/App.css`, `src/theme.ts`, `src-tauri/src/theme.rs`, `src-tauri/src/config.rs`, `src-tauri/src/lib.rs` `generate_handler!`. Clause 3 amended by Editor Wave 6: the IDE surface, Phase 4, issue #62, branch `wave-6`, commit 8342aee."
---

# Central UI configuration system: tokens, theme engine, JSONC settings

**Status note:** current (clause 3 narrowed 2026-08-05, see below)

Tori's UI grew as a 2015-line hardcoded `App.css` with only 10 CSS variables and a thin theme layer (`theme.ts` + `theme.rs`) that *mirrors* the user's installed VS Code theme shallowly and depends on VS Code existing. To make the whole UI configurable "like VS Code," we decided to build a central UI-config system with four durable choices:

1. **Two-tier design tokens.** Primitive `--tori-*` tokens (palette/spacing/radii/fonts/durations) feed semantic role tokens the UI consumes, in a CSS `@layer`. Light and dark are two semantic-token sets keyed on `:root[data-theme]`.
2. **Bundled + importable theme engine, no installed-VS-Code dependency.** Ship VS Code-format themes (Dark+/Light+ with real `tokenColors`) and let users import any VS Code theme `.json` (reusing `theme.rs`'s json5 + `tokenColors` distillation). The focus-mirror of installed VS Code is dropped as a hard dependency. This supersedes the theme half of [[adr_stack_choice]].
3. **Global JSONC settings**, `~/.config/tori/settings.json`, matching VS Code/Cursor (`json5` read, pretty `serde_json` write, comment-preservation deferred). `tori.toml` stays TOML for project *discovery* only; `settings.rs` mirrors `config.rs`'s atomic-write + watcher-echo-suppression. ~~Global-only, no per-project override.~~ **Amended 2026-08-05 (issue #62):** `editorDefaults` resolves through three layers, default < user < workspace, over a `<root>/.tori/settings.json` overlay. Everything else stays global, and the split this clause exists to protect is unchanged: preferences are JSONC and `tori.toml` remains project discovery config, with a test scanning `config.rs` for any `EditorDefaults` key in either spelling. See [[concept_workspace_settings_overlay]].
4. **Incremental CSS Modules migration with a light-mode gate.** `App.css` is migrated to per-component `*.module.css` on tokens, high-traffic first; light mode is not user-selectable until the migration completes, so unmigrated hardcoded-dark components never render half-broken.

Icon size/color are tokenized, but swappable icon *themes* are deferred to a later plan.

## Considered Options

- **Keep mirroring installed VS Code** (rejected): shallow, hard dependency on VS Code, no in-app control.
- **TOML settings** (rejected): VS Code/Cursor use JSONC; JSONC also matches the theme-import format and reuses the existing `json5` reader.
- **Full one-shot `App.css` migration** (rejected): higher risk; incremental keeps each session's diff reviewable.

## Related

- [[concept_workspace_settings_overlay]] — the three-layer resolution that narrows clause 3, and the rule every later feature follows.
- [[adr_stack_choice]] — supersedes its theme-mirroring rationale (VS Code no longer required).
- [[component_cm6_editor]] — CM6 syntax coloring consumes `--syn-*` from theme `tokenColors`.
- [[component_seti_icons]] — icon size/color become tokens here; icon themes deferred.
- [[gotcha_vs_code_theme_colors_cannot_color_syntax_historical]] — bundled themes must carry real `tokenColors`.
