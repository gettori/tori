---
summary: editorDefaults resolve default then user then workspace, and adding one key touches four homes or it fails silently
status: current
updated: 2026-08-08
source: "Editor Wave 6: the IDE surface (personal/sway, branch `wave-6`); Phase 4, issue #62, commits acc2e09 + 8342aee; extended by Phases 5, 8, 13; `src/panels/Settings/workspaceSettings.ts`, `src-tauri/src/workspace_settings.rs`, `src/utils/settingsCatalog.ts`, fourth home added by Editor wave 7 (branch `wave-7`); Phases 6, 9; commits 506d7e7, d7a6e3e"
---

# Per-workspace settings overlay: default < user < workspace

A preference now resolves through three layers: the built-in default, the user's global `~/.config/sway/settings.json`, and a per-workspace overlay at `<root>/.sway/settings.json`. Only `editorDefaults` participates; appearance, typography, chat and harness stay global, because they describe the person and not the repo. The overlay is the whole of #62, and it is deliberately generic: Rust treats its keys as opaque JSON and the frontend validates them against *the shape of the defaults*, so a feature that registers a new setting changes no Rust and gets the overlay, the origin badge, the `Preferences:` command and the settings search for free.

## How it works

- **`parseOverlay(raw, defaults)`** (`workspaceSettings.ts:32`) drops any key not in the defaults and any key whose `typeof` disagrees with the default's. That single rule is what makes a hand-edited file safe: an unknown or mistyped key never reaches CodeMirror.
- **`withOverride<K extends keyof EditorDefaults>`** (`:86`) is generic in the key, so a value must be *that* setting's type rather than any setting's. `setWorkspaceOverride` and `setEditorDefault` follow the same signature.
- **`editorDefaultsFor(root)`** answers for a named workspace, never for whichever one happens to be selected. That distinction was a self-review fix: `formatOnSaveFor(path)` had been lending one workspace's answers to another project's file.
- **`editorOrigins`** (`:70`) decides the panel's badge. **Presence** for the workspace layer (exact: the badge's one hard promise is that "workspace" appears only when the overlay supplies the value) and **value comparison** for user-versus-default, which is a heuristic, since the backend has already filled defaults in and someone who sets a value to what it already was reads as "default". Named in the function's doc rather than hidden.
- **The tracking story is local-only**, via `.git/info/exclude`. The directory is excluded *before* the file is written, so git never reports it even briefly and nothing tracked is touched. `attempts.rs` had already solved this for `.sway-attempts`; it is now `git::exclude_from_repo(root, dir)` shared by both.
- **`settingsCatalog.ts`** is the one home for a setting's name, because three surfaces need it (the panel's rows, the filter box, the command table) and none could own it: `commands.ts` may not import the store, and the store may not import the panel. Its only import is an `import type`, which the bundler erases (see [[concept_command_registry]]).

## Why it's this way

**Every later feature follows one rule: register the setting in `EditorDefaults` and read `editorDefaults()`, never `settings.editorDefaults`.** The second is only the middle layer. Phases 5, 8 and 13 each added a setting and each got the whole overlay stack by following it; sticky scroll's entire settings cost was one field.

**A list of values is stored as a comma-separated string, not an array.** Both generic rules above are exact for a string and wrong for a `string[]`: `typeof` would admit `[1, {}]` (both are `"object"`), and `user[key] !== defaults[key]` would call every workspace value an override, because no two arrays are equal. So `todoPatterns` is text and split at the point of use.

**Which made `EditorDefaults` mixed-type for the first time, so `EditorToggleKey` stopped being `keyof`.** It is now derived (`settingsStore.ts:129`): the keys whose value type extends `boolean`. That is what makes `toggles: "todoPatterns"` a compile error rather than a `Preferences:` command setting a list of tags to `true`. The catalogue gained `edits` beside `toggles` for exactly the settings that get a row and no command, and a test refuses both fields on one entry.

**Only `EditorDefaults` booleans get a toggle command.** A chat or budget boolean is a boolean too, but it has no workspace layer, so a command flipping it would write somewhere the panel's badge cannot explain.

**The cost, stated in the module header:** these settings cannot be shared with a team. The global file is where a preference meant to travel belongs. This supersedes clause 3 of [[adr_ui_config_system]], narrowly: preferences stay JSONC and `sway.toml` stays project *discovery* config, which is the split the ADR actually protects.

## A new `EditorDefaults` key has four homes (2026-08-08, wave 7)

Adding a boolean to the type is a quarter of the work, and the other three-quarters each fail silently in a different way. The homes, and the test that catches each:

1. **The TypeScript type** (`settingsStore.ts`) plus its value in `DEFAULT_SETTINGS.editorDefaults`, which is the type made runtime-visible and the list every other check is derived from.
2. **`settingsCatalog.ts`** — missing here, the setting is invisible in the panel, the filter and the palette at once (`settingsCatalog.test.tsx`). The catalog's `section` also decides whether the row carries its own paragraph (`editor`) or is a line in the comfort list (`editing`), which `editorSection.test.tsx` pins separately.
3. **`settings.rs`'s struct** — missing here, serde drops the field on the way in and writes it back out gone, so the toggle flips, saves, and snaps back with nothing said. Guarded by a `settings.rs?raw` scan in `workspaceSettings.test.ts`, plus a per-key round-trip test.
4. **Both settings JSON schemas** (`sway-settings.schema.json`, `sway-workspace-settings.schema.json`) — missing here, the user's own settings file reports the new key as an unknown property. Guarded by `settingsSchema.test.tsx`.

**The fourth home is two files, and a test is what keeps it one home.** `editor` means the per-project override *map* in the global file and the override *block* in a workspace file, so one schema would misreport whichever it was not written for. `settingsSchema.test.tsx` asserts the two editor blocks are identical **by value**, so they cannot drift. It also checks each key's `type` against `typeof` the shipped default, its `default` against the shipped value, and that its description leads with the catalog's label — with the label asserted non-empty *first*, because `startsWith("")` is trivially true and a key that fell out of the catalog would otherwise leave the test passing while checking nothing.

The tests fail in home order, and each names the file to edit, so adding a key and running the suite walks you through the remaining three.

## Related

- [[adr_ui_config_system]] — the decision this narrows; clause 3's "global-only" no longer holds.
- [[component_settings_store]] — the global layer beneath it and the panel that renders the badge.
- [[concept_command_registry]] — why `settingsCatalog.ts` is the only module `commands.ts` may import besides `./events`.
- [[concept_schema_backed_json]] — how those two schemas reach the JSON server, and why the file is opened as `jsonc`.
- [[component_code_lens]] — the first key to go through all four homes.
- [[gotcha_createstore_default_settings_proxies_the_defaults_object_itself]] — the production bug the layering exposed.
- [[gotcha_a_frontend_settings_key_with_no_rust_field_is_dropped_on_save]] — the sibling trap a scan test now guards.
