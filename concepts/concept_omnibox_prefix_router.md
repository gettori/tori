---
summary: one box resolves its mode purely from the query's own prefix, so nothing on screen can ever disagree with what it shows
status: current
updated: 2026-08-05
source: "Editor Wave 6: the IDE surface (personal/tori, branch `wave-6`); Phase 6, issue #59, commit b58c96a; `src/utils/omniboxModes.ts`, `src/components/Omnibox/Omnibox.tsx`"
---

# The omnibox: a mode is a function of the query, never state

Quick-open and the command palette became one box. Six modes hang off a prefix: bare (files), `>` (commands), `@` (document symbols), `#` (workspace symbols), `:` (go to line), `?` (the box explaining itself). `CommandPalette.tsx` and `QuickOpen.tsx` are deleted; what survives is the chrome of the more complete of the two.

## How it works

- **`MODES`** (`omniboxModes.ts:33`) is the prefix table and **`parseQuery`** (`:55`) splits a raw string into `{ mode, rest }`. Nothing remembers a mode separately from the text, so nothing can disagree with what is on screen, and the whole router is testable with no DOM.
- **Five sources, and the sixth mode is the signpost.** Files come from [[concept_path_keyed_workspace_stores]]'s `rankByFrecency`, commands from `COMMANDS[]`, symbols from `requestDocumentSymbols` / `requestWorkspaceSymbols`, the line from a parse. Phase 5's thirty `Preferences: ...` rows arrive through `COMMANDS[]`, so `>` already covers settings and no seventh mode was needed.
- **`?` rows *enter* the mode they name** rather than closing the box; a signpost that dismissed the thing it was explaining would undo the reason it was opened.
- **The empty box is three sections in order:** "Recently visited" (the jump list), "Recent files" (frecency), then "Project", with everything already offered filtered out of the ranked tail. The two "recent" ideas were merged precisely because on one surface they would otherwise put a worked-in file on two rows.
- **`recentTargets` dedupes on path *and* line.** A file and a symbol inside it are two destinations; collapsing them by path hides the precise one behind the vague one exactly when both are wanted. It also skips the entry the cursor stands on.
- **Built on `CommandPalette`'s chrome**, not `PickerModal`'s: the shared `Dialogs.module.css` `.modal .picker`, its Portal, `role="listbox"` and section headers. `PickerModal` is the sidebar's single-select dialog, one string per row with no sections, key chips or disabled reasons.

## Why it's this way

**⌘P and ⌘K stayed two bindings on purpose.** One event (`OPEN_OMNIBOX { prefix }`), one component, one App signal, but two keys: "which file" and "what can I run" are asked differently often, and being one prefix away does not make a detour worth it. `hotkeys.test.ts` now asserts on the *payload*, because the event name can no longer tell the two apart.

**The signal holds `{ prefix }` rather than a bare string, and the `Show` is keyed.** `""` is a legitimate prefix and a falsy one, so `when={omnibox()}` on a string would have made ⌘P open nothing. The object also gives ⌘K over an already-open box a fresh identity, which remounts it into `>` mode instead of leaving it wherever the last keystroke put it.

**The jump list is published, not persisted.** It is session-lived and lives in `Editor.tsx`, so the omnibox reads it through `editorState` the way it already reads the active path, rather than through storage the way it reads frecency. `recentJumps` is a **required** field of `EditorSnapshot`, following that module's rule that a snapshot's parts describe one moment.

**Anything the box loads must be loaded lazily per mode.** Phase 14 added task rows and read them in `onMount`, which made every ⌘P pay for a `git check-ignore` subprocess it would never show a row from. Tasks now load the first time the box is actually in `>` mode.

## Related

- [[component_command_palette]] — the registry and hotkey dispatcher this box renders; the two components it replaced.
- [[concept_command_registry]] — where `>` mode's rows come from.
- [[component_editor_navigation]] — the jump list behind "Recently visited".
- [[component_editor_symbols]] — the `@` and `#` sources.
- [[gotcha_fs_read_dir_shells_out_to_git_check_ignore]] — why an eager load in this component is expensive.
