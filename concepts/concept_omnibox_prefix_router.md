---
summary: the mode is the query's prefix, else the key that opened the box; a pasted path or port is read before the router
status: current
updated: 2026-11-20
source: "Editor Wave 6: the IDE surface (personal/tori, branch `wave-6`); Phase 6, issue #59, commit b58c96a; `src/utils/omniboxModes.ts`, `src/components/Omnibox/Omnibox.tsx`; homes, `/` and paste from plan \"Cmd+K navigator\" (branch `cmdk-improvements`), commits `2e647536`, `84e3748d`, `938751d7`"
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

## Since the Cmd+K navigator (2026-11)

The rule "nothing but the text sets the mode" no longer holds on its own. A
query with no prefix means what the opening key asked for, so the box carries a
**home** for its whole life: `file` from Cmd+P, `all` from Cmd+K
(`parseQuery(raw, home)`, `src/utils/omniboxModes.ts`). The tag in the field
shows the home's name and lights up only when a prefix has left it.

- **Files took `/`**, so they stay one keystroke away from Cmd+K. `all` is the
  one mode with no prefix, so the `?` list from Cmd+P does not offer it.
- **`#` plus digits is a number in the all home**, not a workspace symbol
  search (`/^#\d+(\s|$)/`); from Cmd+P it is still symbols. See
  [[concept_navigator_ranking]].
- **A paste is read before the router.** An absolute path inside a known unit
  and a `localhost:<port>` (`pathQuery`, `portQuery` in `src/utils/navNumber.ts`)
  resolve to a place in either home and keep the mode at the home. Without
  that, an absolute path starts with the files prefix and would search files
  for `Users/...`. A path no unit holds still goes to the router.

The state the text cannot show is still small and fixed: the home, set by the
key and never changed while the box is up. Why the home exists at all is in
[[adr_cmdk_is_a_navigator]].

## Related

- [[component_command_palette]] — the registry and hotkey dispatcher this box renders; the two components it replaced.
- [[concept_command_registry]] — where `>` mode's rows come from.
- [[component_editor_navigation]] — the jump list behind "Recently visited".
- [[component_editor_symbols]] — the `@` and `#` sources.
- [[gotcha_fs_read_dir_shells_out_to_git_check_ignore]] — why an eager load in this component is expensive.
- [[adr_cmdk_is_a_navigator]] why a bare query from Cmd+K is everything, not files.
- [[component_nav_index]] what the all home searches.
