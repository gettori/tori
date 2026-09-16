---
summary: a settings key added only in TypeScript is dropped by serde on save, so it reverts after appearing to work
status: current
updated: 2026-08-11
source: "Editor Wave 6: the IDE surface, Phase 8 (personal/sway, branch `wave-6`); `src-tauri/src/settings.rs`, `src/panels/Settings/settingsStore.ts`; commit 2185971; _2026-08-05_, section-level half added by Settings redesign (branch `settings`, issue #91) Phase 1; commit 1dc97b4"
---

# A frontend settings key with no Rust field is dropped on save

Do NOT add a setting to the TypeScript settings shape without adding it to `settings.rs`'s struct in the same change. `set_settings` takes the *typed* struct, so serde drops the unknown key on the way in and writes the file back without it: the setting appears to work until it is saved, then reverts forever. `compactFolders` shipped that way for four phases. A test now scans `settings.rs?raw` for every frontend `editorDefaults` key. Why: nothing in either toolchain compares the two shapes, and the frontend half looks complete on its own.

**And the guard is narrower than the trap.** It covers `editorDefaults` keys only, so a whole top-level *section* walks straight past it - `budgets` did, for as long as spend ceilings existed: three fields the panel wrote and every save discarded. When adding a section, mirror it in `settings.rs` and give it a round-trip test of its own; the per-key scan will not notice. Note also that `Option` fields need an explicit `#[serde(default)]` (serde requires them present otherwise), and that a non-optional field in a new section needs a **named** default fn or a hand-edited file setting one key zeroes its siblings.
