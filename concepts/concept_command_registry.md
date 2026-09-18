---
summary: one COMMANDS table behind the palette and sheet may only import events, keeping everything out of the terminal's chunk
status: current
updated: 2026-08-05
source: "Editor wave 1: close out the fundamentals (personal/tori, branch `wave-1-4`); Phase 3, issue #15; commit bd9567c; `src/utils/commands.ts`, `src/utils/hotkeys.ts:44`"
---

# One command registry behind the palette, the sheet and the dispatcher

Everything runnable by name lives in one table, `COMMANDS` in `src/utils/commands.ts`. The Cmd+K palette lists it, the Cmd+/ sheet lists the subset that carries keys, and `dispatchHotkey` matches against that same subset. Before this, the palette built its rows inline and `hotkeys.ts` held a separate `BINDINGS` table, so one action could be listed twice under two names ("View: Toggle Terminal" in the palette, "Show or hide the terminal" in the sheet), and anything without a key could not be reached by name at all. The interesting part is not the merge, it is the constraint the merged table had to satisfy: `commands.ts` may import **only** `./events`.

## How it works

- **`BINDINGS` is derived, not maintained.** `hotkeys.ts` filters `COMMANDS` down to the entries carrying `keys` + `scope` + `match` (`hotkeys.ts:44`). `dispatchHotkey` / `dispatchWindowHotkey` / `bindingsByGroup` keep the signatures they always had, so `App.tsx`, `TerminalView.tsx` and `ShortcutSheet.tsx` did not change at all. A command cannot advertise a key the dispatcher does not fire, because they are the same row.
- **Every `run` emits an event.** No command calls the thing it means. "Save file" emits `EDITOR_SAVE`, which `CodeEditor` consumes because it holds the buffer; the tab and git commands emit into `Editor.tsx`, which is always mounted and is the only component that knows both the selected workspace and the active file.
- **Enablement is a declarative tag.** `requires?: Requirement[]` names what must hold (`editorFile` | `gitRoot` | `staged` | `ahead`); the palette resolves the tags against [[component_editor_stores]] and turns the first unmet one into the row's refusal reason ("Nothing staged", "Nothing to push"). A disabled row still lists — that is where its reason is shown — but does not run, and picking it leaves the palette open rather than dismissing it on an action that did nothing.
- **`hidden` keeps four entries out of a list of names**: the palette itself, `tab-jump` (its target is the key that fired it, so it means nothing without a key event), `terminal-search` (the focused xterm owns it, so it has no `run`), and `stop-chat` (the palette lists every stoppable chat by name instead, which is the case that binding deliberately refuses to guess at — see `chatToStop`).
- **The palette adds what a static table cannot hold**: a row per registered agent and a row per running chat are lists that only exist at runtime.

## Why it's this way

**The import list is a chunk-size constraint, not a style choice.** `TerminalView` imports `hotkeys.ts` to route keys past a focused xterm ([[gotcha_a_focused_xterm_swallows_keydown_before_window]]), and `hotkeys.ts` now imports `commands.ts`. So anything reachable from the table lands in the terminal's chunk. That is the whole reason `run` emits an event rather than calling `gitActions`, and the whole reason `requires` is a tag rather than a predicate reading a store: resolving it is the palette's job, and the palette already sits at the leaf of that graph where reading the editor and git stores costs nothing. `commands.test.ts` asserts the import list is exactly `["./events", "./settingsCatalog"]`, because this is the kind of invariant that a single convenient import silently ends.

**The list widened by exactly one module, and the widening is checked rather than promised** (2026-08-05, wave 6). Generating a `Preferences: ...` row per setting needs a setting's *name*, and three surfaces need it: the panel's rows, the settings filter box, and this table. None could own it, since `commands.ts` may not import the store and the store may not import the panel, so `src/utils/settingsCatalog.ts` is that home. Its only import is an `import type`, which the bundler erases, and the test now asserts **both** halves: the two-entry import list, and that the catalogue itself has no runtime import. That is what keeps the substance of the invariant alive after its letter changed. See [[concept_workspace_settings_overlay]].

**A mode or panel registered in one table and not its siblings is unreachable.** `RIGHT_MODE_TABS` gained `todos` while `modeOrder` did not, and `rightTabs()` is `modeOrder().filter(...)`, so a finished panel shipped with no way to open it for a whole phase. A right-panel mode needs four entries (`RIGHT_MODE_TABS`, `modeOrder`, `SetRightMode`, this table's `RIGHT_MODES`); see [[lesson_a_registered_command_with_no_caller_is_not_shipped]].

**One table means one label.** The palette now shows the sheet's wording for a shared command. Two registers ("View: Toggle Sidebar" vs "Show or hide the sidebar") is exactly the drift the merge exists to remove.

**Save deliberately has no key.** CodeMirror's own `Mod-s` stays the only save key; a table-level binding would be `global` or `window` scoped and would fire while a terminal had focus, saving a file nobody was looking at. `hotkeys.test.ts` pins that Cmd+S is claimed by neither dispatcher.

## Related

- [[component_command_palette]] — the surface that renders the table and resolves its tags.
- [[component_editor_stores]] — what the `requires` tags are resolved against.
- [[concept_capability_resolution]] — the same "a gate is declared, never keyed on an id" rule, applied to session controls rather than commands.
- [[lesson_a_registered_command_with_no_caller_is_not_shipped]] — why every `run`'s consumer needs a test that drives it, not just a table entry.
- [[gotcha_a_listener_registered_after_an_await_in_onmount_misses_what_fires_in_that_window]] — the trap that bit the consumer side of two of these events.
