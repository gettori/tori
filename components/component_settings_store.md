---
summary: Settings store resolves formatOnSave in three states (null, false, true) with ??; vimMode has no per-project form
status: current
updated: 2026-08-14
source: "Central configurable UI system (personal/tori, branch code-mirror-6); Phases 3, 4; commits 94055c9, 631d16e; theme rework: Native theming system: palette + roles generator (branch `terminal-editor-design`) Phases 2, 7"
---

# Global settings store & panel

**Location:** `src-tauri/src/settings.rs`, `src/panels/Settings/{settingsStore.ts,Settings.tsx,scale.ts}`, `src-tauri/src/lib.rs`

Tori's user-preference layer: a global JSONC file, a reactive frontend store, and an in-app panel. Distinct from `tori.toml`, which is project *discovery* config ([[component_project_discovery]]); this is **user preferences** (appearance / typography) at `~/.config/tori/settings.json`.

## Editor preferences, and which shape a setting takes (2026-08-03, wave 4)

Two editor settings landed together and resolve **differently on purpose**, which is the durable part:

- **`editorDefaults.formatOnSave`** has a per-project override in an `editor[path]` map keyed like `chat`. Three answers, not two: absent/`null` means "this project has never been asked" and falls through to the default, while `false` is a project that was asked and said no and must not be overruled. A resolution written with `||` instead of `??` collapses the second into the first and quietly reformats a repo that had opted out.
- **`editorDefaults.vimMode`** has no per-project form at all.

The rule behind the split: **which formatter runs is a property of the repo; whether `hjkl` moves the caret is a property of the person.** A per-project vim setting would mean the same hands typing differently in two windows of the same editor. Ask which of the two a new preference is before adding it.

Both default **off**. `formatOnSave` because a repo carrying a `.prettierrc` is not necessarily one that is currently formatted, and the first save would rewrite a file the user never touched — opting in is cheap, opting out after the fact is a revert.

`toggleVimMode()` lives in the store rather than in `Settings.tsx`, because the command palette can flip it and the panel is not necessarily open when it does. It spreads `editorDefaults` rather than rebuilding it; a test pins that, since rebuilding would silently switch format-on-save off.

**Found in passing, not fixed:** the frontend `Settings` type carries a `budgets` section `settings.rs` has no field for, so `set_settings` drops it on every save. **Fixed 2026-08-11** (settings redesign, phase 1, commit 1dc97b4): `Budgets` now exists in the Rust struct with the three ceilings as `Option<f64>` and `warnAtFraction` on a named `#[serde(default = "…")]` fn. `None` is unlimited and stays distinct from `Some(0.0)`, which is a user asking to be stopped at once. The trap is the same one [[gotcha_a_frontend_settings_key_with_no_rust_field_is_dropped_on_save]] describes, one level up: the existing guard scanned `settings.rs?raw` for every `editorDefaults` key and had nothing to say about a whole top-level section.

## Backend (`settings.rs`)

- Mirrors `config.rs` (notify watcher, atomic write, echo-suppressed emit) but stores JSONC: **`json5` on read** (comment-tolerant, VS Code/Cursor-style), **pretty `serde_json` on write** (comment-preservation deferred).
- `Settings { appearance{theme, importPath}, typography{uiFont*, editorFont*, lineHeight}, checkpoints{enabled} }`; every field `#[serde(default)]` + `rename_all="camelCase"`, so a partial file fills gaps and a missing/invalid file falls back to defaults without panicking. `checkpoints.enabled` (added by [[component_turn_checkpoints]], Phase 4, default `true`) is a separate struct with its own manual `Default`, matching this file's existing per-section pattern rather than a bare top-level bool (which `derive(Default)` would default to `false`). The old `layout{density, radius}` section was **removed** in favour of the uniform `--ui-scale` ([[concept_ui_scaling_system]]); because there is no `deny_unknown_fields`, an old file carrying a top-level `layout` key still loads (serde ignores it) and the next write drops it.
- Structured as a **pure core** (`load_from`/`save_to` taking an explicit path) + thin path wrappers, per [[lesson_pure_core_for_global_stores]], so load/save is unit-tested off-disk (4 tests: missing / invalid / partial / round-trip).
- Commands: `get_settings`, `set_settings` (emits `settings://changed`), `settings_watch_start` (dir watcher also fires, idempotent double-load like `config.rs`).

## Frontend (`settings.ts`)

- A Solid `createStore` (reactive for the panel). `applySettings` writes tokens as inline props on `<html>` (`--tori-font-ui`, `--editor-font-*`, `--ui-scale`, `--ui-line-height`) into the [[concept_design_token_system]]; the CM6 theme reads `--editor-font-*` via `var()` so font changes are live. `--ui-scale = (uiFontSize/15) × zoom` is computed by the pure, DOM-free `scale.ts` (unit-tested off-DOM like the resolver) and drives the whole chrome, see [[concept_ui_scaling_system]].
- `applyAll` = tokens + `setTheme(appearance.theme)`, run by both load and save. **`settings.appearance` is the single source of truth for the theme**; `applyCachedTheme` handles FOUC only. The VS Code import branch is gone, and `applyAll` is synchronous again now that nothing awaits an import round-trip.
- **Two watchers, and the theme one is second on purpose.** `initSettings` loads user themes *before* settings, because `settings.json` may name one and resolving it after the first paint would flash the fallback and report a theme that in fact exists. It then starts `settings://changed` and `themes://changed`. A themes-folder change only re-applies when the active theme came from that folder, so saving an unrelated theme file does not repaint the app.
- **`setTheme` returns problems, and the store is what shows them**, as toasts capped at three plus a count (the contrast gate reports every failing pair, and a hand-edited palette can fail dozens). Silently landing on a different theme than the settings file names is exactly the "my theme changed on its own" the import notice exists to avoid. See [[component_theme_engine]].
- `initSettings()` runs in App `onMount` (load + `settings_watch_start` + `listen("settings://changed")`); TS `DEFAULT_SETTINGS` deliberately duplicates the Rust defaults (two runtimes).

## Panel (`SettingsPanel.tsx`)

- Portaled overlay (same pattern as `ConfirmDialog`: backdrop/Escape close, rAF focus), opened by a **topbar gear** (always visible, unlike the session-scoped Toolbar). It is the first component authored on the target architecture: a scoped `.module.css` in the `components` layer reading only tokens.
- Controls commit on `onChange` (blur, not per-keystroke) → `saveSettings` → persist + `applyAll` (live). Numeric inputs go through a `clamp` helper that rejects empty/NaN/out-of-range so a blank font size can't blank the UI. The theme `<select>` groups options by source (`Bundled` / `From ~/.config/tori/themes`) and binds through a `currentTheme()` that falls back to the default for an id no longer installed, so a stale settings file renders the theme that is actually painted rather than a blank control.

## Chat and Harness sections (2026-07-28)

Two sections added for [[component_chat_panel]], both following the per-section struct + `#[serde(default)]` pattern:

- **`chatDefaults`** - `defaultSurface` (`chat` | `agent`, the fallback restoring PTY-as-default), seed `model`/`effort`/`mode` for a project with no remembered pick of its own, `streaming`, `density`, `toolOutputLines`, `showToriHooks`, and `maxConcurrentChats`.
- **`harness`** - `path`, overriding the discovered binary. Read from disk at each spawn rather than cached, since the setting exists precisely to try a different binary and a restart would defeat it.

Note the naming: the pre-existing `chat` key is the **per-project** pick map and was left alone. Folding both into one key would have reshaped a field users already have on disk, and `load_from` has no per-section recovery - one section failing to deserialize takes the whole file down to defaults, losing the user's theme over a chat preference. Non-default primitives (`streaming: true`, `toolOutputLines: 20`, `maxConcurrentChats: 4`) use `#[serde(default = "...")]` functions, since a bare `#[serde(default)]` on a bool would silently ship streaming off for every existing settings file.

**A key can also leave, and `ChatDefaults` is why that is cheap here.** `approvalAutoDenySecs` was removed on 2026-08-14: it round-tripped through both stores and rendered in Settings under **Safety**, claiming "Tori owns this timeout so it always fires before the harness's own", while the deadline that fires is the `approval::DECIDE_TIMEOUT_SECS` constant and always was. The struct carries no `deny_unknown_fields`, so a `settings.json` still holding the key parses, ignores it and drops it on the next save. That is worth checking rather than assuming - see [[gotcha_deny_unknown_fields_makes_a_deleted_field_a_migration]] for the sibling struct where the same deletion would have failed every file on disk at once.

## A per-workspace layer, and one home for a setting's name (2026-08-05, wave 6)

`editorDefaults` gained a third layer below the user's file: a `<root>/.tori/settings.json`
overlay, resolved default < user < workspace. The mechanism, the tracking story
and the rules it imposes on every later feature live in
[[concept_workspace_settings_overlay]]; what changed *here* is worth naming:

- **`toggleVimMode` and the panel's two hand-written rows now write the layer in
  force**, not the middle one. Before the fix, a workspace overriding `vimMode`
  made the palette's toggle flip the global value under an overlay that kept
  winning, so the shortcut did nothing however often it was pressed. Both
  surfaces go through one `setEditorDefault`, and `prefsCommands.test.tsx`
  states it as a comparison (the command's call must equal the checkbox's).
- **`editorDefaultsFor(root)` refuses to lend one workspace's answers to
  another.** `formatOnSaveFor(path)` had been falling back to the *selected*
  workspace's overlay regardless of `path`.
- **`EditorToggleKey` is derived, not `keyof`** (`settingsStore.ts:129`), since
  `EditorDefaults` is mixed-type from `todoPatterns` onward. `withOverride`,
  `setWorkspaceOverride` and `setEditorDefault` are generic in the key.
- **`src/utils/settingsCatalog.ts` is the single home for a setting's label and
  hint**, because the panel, the filter box and `COMMANDS[]` all need it and
  none can own it. Its guard test (every `EditorDefaults` key registered exactly
  once, `toggles` and `edits` never both on an entry) is what catches a setting
  that exists in the type and nowhere a user can see.
- **Every setting is a `Preferences: ...` palette row**, and a row fired at an
  already-open panel re-filters it: the prop is watched with
  `on(..., { defer: true })` plus `equals: false` on App's signal, so running the
  same row twice works and an unrelated re-render does not yank the box back.

## A setting's fourth home: the shipped JSON schema (2026-08-08, wave 7)

Tori now ships two JSON schemas for its own settings files and feeds them to the
bundled JSON language server, so editing `~/.config/tori/settings.json` by hand
flags an unknown key, checks a value's type, and completes each key with the
description the panel shows. That makes the schema the **fourth home** of an
`EditorDefaults` key, after the type, `settingsCatalog.ts` and `settings.rs`.

Two files rather than one, because `editor` collides: it is the per-project
override *map* in the global file and the override *block* in a workspace file.
`settingsSchema.test.tsx` holds their editor blocks identical by value, which is
what keeps the fourth home one home. See
[[concept_workspace_settings_overlay]] for the full list and the test that
guards each, and [[concept_schema_backed_json]] for how the schemas reach the
server (and why those two files are opened as `jsonc`, not `json` — Tori reads
them with json5, and the server treats a comment as an error under any other id).

## The panel becomes six tabs (2026-08-11, settings redesign)

One scrolling column of eleven sections - two of them titled "Editor" - became a
strip of six tabs over the same sections, with one header search across all of
them. The grouping, the pane split and the bundle constraint that keeps the
catalogue data-only are in [[concept_settings_tab_layer]]; the search, its
per-tab count badges and the rule that typing never navigates are in
[[concept_counting_search]]. What is worth naming *here*:

- **The panel finally makes the claims it should.** `role="dialog"`,
  `aria-modal`, a real focus trap (`ShortcutSheet` had the role and focus restore
  but no Tab cycling) and a two-stage Escape that clears the query before it
  closes. Escape sits on the panel element, **not** on `window` in the capture
  phase as `ShortcutSheet` does - see
  [[gotcha_a_capture_phase_window_listener_reaches_over_a_modal_opened_on_top_of_you]].
- **Three preferences that worked but could only be found by knowing the
  shortcut got rows**: zoom ([[concept_ui_scaling_system]]), git blame and
  side-by-side diffs. All three are **bare catalogue entries** - no `toggles`, no
  `edits`, the same shape as the four card-section entries - which is what makes
  them searchable and gives them open-and-filter palette rows without generating
  toggle commands for values the layer resolution does not answer for.
- **Those two reader preferences are localStorage, not `editorDefaults`**, so
  their rows carry no workspace badge and no "Set here": there is no overlay layer
  under them to write. Both became module-level signals in the process, because a
  row and the editor's own toggle are two surfaces on one preference; the way that
  quietly hollowed out an existing test is
  [[lesson_shared_state_makes_a_test_order_dependent]].
- **`OpenSettings` carries `entry` beside `query`.** The query is a filter, not an
  address: it gets you to a tab, and a `Preferences:` row names one setting. The
  panel scrolls to the row, focuses its control and flashes it. A card section
  gets the scroll and the flash but never focus - its contents are built at
  runtime, so the first control inside GitHub is a sign-out button.

## Boundaries

- Appearance, typography, chat and harness stay **global**: they describe the
  person, not the repo. Only `editorDefaults` has a workspace layer.
- The overlay is **local-only** (excluded via `.git/info/exclude`), so these
  settings cannot be shared with a team. The global file is where a preference
  meant to travel belongs.
- A write rebuilds the overlay from `{ editor }` alone, so a later phase adding a
  second top-level section must preserve the others.
- No watcher on the overlay: a hand edit needs a workspace switch to take effect.
  The global file has one.
- No comment-preserving surgical JSONC writes yet (deferred).

Recorded in [[adr_ui_config_system]], whose clause 3 this amends.
