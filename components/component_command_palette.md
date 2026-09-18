---
summary: one COMMANDS table drives the palette, the shortcut sheet and the dispatcher, so a binding cannot drift from its list
status: current
updated: 2026-08-28
source: "v0.1 features: status indicators, search, input layer (personal/tori, branch `topbar`); Phase 3; binding table + sheet: v0.1 release gate, same branch, Phase 4, commit 0a0a1d3; merged into one registry by Editor wave 1: close out the fundamentals (branch `wave-1-4`), Phase 3, issue #15, commit bd9567c; shell and list moved onto shared surfaces by plan \"Consolidate the filter-and-pick surfaces onto one Kobalte Combobox\" (branch `110-pickermodal-and-chatpicker`, issue #110, PR #140); commit `9d471b7`; quick-open across a Feature's members from Repository identity on tabs, breadcrumbs, quick-open and menus (branch `feature-workspace`, issue #158), Phase 4, commit `809c85b`"
---

# Command palette + hotkey remap

**Location:** `src/utils/commands.ts`, `src/components/CommandPalette/CommandPalette.tsx`, `src/utils/hotkeys.ts`, `src/components/ShortcutSheet/ShortcutSheet.tsx`, `src/App.tsx`, `src/panels/Terminal/TerminalView.tsx`

Two related pieces landed together: a Cmd+K fuzzy command palette, and the full hotkey remap it depends on (Cmd+1..9 tab jump, Ctrl+Tab cycle, Cmd+Shift+A next-waiting-session, Cmd+Shift+E sidebar search, Cmd+J terminal). The remap's defining constraint is that every binding must also fire while an xterm terminal has DOM focus.

## One registry for all three surfaces (2026-08-02)

The palette no longer builds its rows inline, and `BINDINGS` is no longer a table
anyone maintains. Both are views over `COMMANDS` in `src/utils/commands.ts` — see
[[concept_command_registry]] for the mechanism and for why that module may import
only `./events`.

What changed here: the palette lists the whole table (minus four `hidden`
entries), showing **key chips** for the commands that also carry a binding, and
renders a command whose `requires` tags are unmet as a **disabled row carrying
its reason** ("No file open", "Nothing staged", "Nothing to push") rather than
hiding it — a row you cannot find teaches you nothing. Picking a disabled row
does nothing and leaves the palette open. It gained the editor and git groups
along the way (save, close tab, toggle preview, go to line, stage, unstage,
commit, push), and shared commands now read with the **sheet's** wording, since
one command cannot be called two things ("Show or hide the terminal", not
"View: Toggle Terminal").

`GROUP_LABELS` gained `editor` and `git`; neither carries a key, so both drop out
of the Cmd+/ sheet, which lists exactly what it always did.

## The palette and quick-open became one omnibox (2026-08-05, wave 6)

`CommandPalette.tsx` and `QuickOpen.tsx` are **deleted**. Both are now
`src/components/Omnibox/Omnibox.tsx`, a single box whose mode is a prefix on the
query (bare = files, `>` = commands, `@` = document symbols, `#` = workspace
symbols, `:` = go to line, `?` = the box explaining itself). The mechanism and
its reasoning are in [[concept_omnibox_prefix_router]]; what matters to *this*
page:

- **⌘P and ⌘K remain two registry entries** driving one event
  (`OPEN_OMNIBOX { prefix }`), one component and one App signal. The second
  `App.tsx` signal is gone. `hotkeys.test.ts` now asserts on the **payload**,
  because the event name can no longer tell the two keys apart.
- **`>` mode is this table**, disabled rows, reasons and key chips included, plus
  the thirty `Preferences: ...` rows wave 6 generated from
  [[concept_workspace_settings_overlay]]'s catalogue.
- **The import rule for `commands.ts` widened by exactly one module, and the
  widening is checked rather than promised.** `commands.test.ts` now asserts the
  import list is `["./events", "./settingsCatalog"]` **and** that the catalogue
  itself has no runtime import, so the substance of the invariant (nothing heavy
  reaches `TerminalView`'s chunk) survives its letter changing.
- **`RIGHT_MODES` gained `todos` and `tasks`**, and so did `modeOrder` and
  `SetRightMode`. A mode registered in one of those tables and not the others is
  a panel nobody can reach: see
  [[lesson_a_registered_command_with_no_caller_is_not_shipped]].
- **`rerun-last-task` (⌘⇧B)** joined the table, emitting `RUN_LAST_TASK`; App
  toasts when there is nothing to re-run. See [[component_task_runner]].
- **Anything the box loads must load lazily per mode.** Reading the task list in
  `onMount` made every ⌘P pay for a `git check-ignore` subprocess for rows the
  file picker never shows.

## The shell became a Dialog and the list became a Combobox (2026-08-16, #110)

`Omnibox.tsx` kept its own portal, backdrop, `role="dialog"` and mousedown-outside dismissal long after all fourteen dialogs had moved onto Kobalte, on the reasoning that a command bar is not a dialog. It behaves like one in every way that matters, so it composes [[component_dialog]] now, and its filter and result list render through [[component_combobox]]. What is left in the file is what a palette *row says* and what *picking one means*.

- **The shell had no assertions at all.** No Escape, no outside press, no focus, no axe. The entire hand-rolled shell was replaced and all 48 existing cases stayed green, which is a fact about their coverage rather than about the change. Eleven cases added, across the shell, the grouping, and the two adopted defaults below.
- **No new `DialogSize`.** The palette's width was already `confirm`'s, character for character, and its padding, surface, border, radius and shadow were `Dialog`'s panel exactly. Only the height bound differed (70vh/520px against 85vh/720px), so it passes `size="confirm"` and sets `--dialog-max-height` from its own class. A new size would have duplicated a width to vary a height.
- **z-index moved 1100 to 1250.** The old value put toasts (1200) above the palette. As a real modal it now aria-hides the toast region, which is the reason `Dialog` sits above toasts in the first place, so the new order is the coherent one.
- **Escape is gone from `onKeyDown`.** `Dialog` closes on it and reports through `onClose`; answering it here as well would fire twice.
- **`title="Command palette"` is hidden** (`titleHidden`), because the visible heading names the *mode* ("Files", "Commands") rather than the surface. The accessible name arrives by `aria-labelledby`, not `aria-label`. It also needed a `KEPT` entry in `interactiveTitle.test.ts`, the source-text guard for native `title=` attributes from #102, which cannot tell a component prop from an HTML attribute.

### Two Kobalte defaults adopted over #100's deliberate choices

Both have a test named after the default it adopts.

- **Section headings are presentational, not `aria-hidden`.** The worry either way was that a heading announced as an option would read as a row the arrow keys skip. `role="presentation"` answers it without hiding the text, so the heading stays readable and the tree still holds only options. Better than what it replaced.
- **Disabled rows are arrow-unreachable.** A command whose requirement is unmet still lists with its reason and still refuses to run, but the arrows now skip it, so the reason is readable on screen only. #100 let the arrows land on it precisely so the reason could be heard. **This is a real regression, accepted.**

### The row model

`Row.section` maps onto the surface's group contract. A list is wholly grouped or wholly flat, never both, because Kobalte throws on the mix ([[gotcha_kobaltes_optiongroupchildren_is_all_or_nothing]]). Every mode but the empty file list is flat, and that one already headed its project tail (`"Project"`) as well as its two recent blocks, so the two shapes never meet. That invariant is now a test rather than an accident.

Picking is an **event**, not a selection: the surface pins its value empty, which is what keeps the `?` signposts working when the same one is picked twice ([[gotcha_an_uncontrolled_kobalte_combobox_treats_a_repeat_pick_as_a_deselect]]).

The scroller is `Dialog`'s body and the filter field is sticky. The list stopped being the scroller one commit earlier without anyone noticing: [[lesson_a_declaration_goes_inert_when_its_parent_changes]].

The sections below describe the palette as it was before the merge; the registry,
scope and dispatcher halves are unchanged and still current.

## Quick-open across a Feature's members (2026-08-28, #158)

The box was single-root throughout: `files` was a `string[]` of rel paths, `MAX_RESULTS = 200` was one shared cap, and the frecency read was keyed by `folderPath` while `Editor.tsx` had been writing it under `wsKey` since #154, so a Feature's ranking never matched what it had recorded. All four are fixed together, because this is the one surface that can reach a file in a repo that is **not** the one in front of you.

- **Per-root listing, all at once.** `files` is now `ProjectFile[]` of `{ root, rel }`, filled by one `Promise.all` over `roots()` (`sel.roots` inside a Feature, the single root otherwise). Not streamed in: rows that arrive one member at a time shift under a cursor that is already moving.
- **The root rides on the id as well as the label.** `file:<root>:<rel>`, so two members' `package.json` are two rows rather than one that collides.
- **Labels are `<repo>/<rel>`, and the fuzzy score runs against the label.** Typing the repo name narrows the list the same way typing a folder name does, with no separate filter to learn. `pathLabel` handles the two blocks that start from an absolute path (the jump list, Recent files) through `memberFor` over the **full** member list, `rootOf(abs, roots())` only as a fallback; see [[lesson_labelling_through_present_roots_drops_the_broken_member]].
- **Two caps, not one.** Untyped, `MAX_RESULTS` is applied **per root** while walking the globally frecency-ranked list, because one shared cap over eight members silently drops the last members entirely and a member with no rows reads as a member with no files. Once a query has scored the list, one global cap: scores are comparable across members, so the best 200 really are the best 200.
- **Frecency reads `workspaceKey(props.selected)`**, matching the write. Entries inside stay absolute paths.

## Responsibilities

- **A canonical command table** (`commands.ts`): every entry carries `id`, `label`, `group`, and optionally `sub`, `keys`, `scope`, `match(e)`, `run(e)`, `requires`, `hidden`. `BINDINGS` (`hotkeys.ts:44`) is the subset carrying `keys` + `scope` + `match`. Both the dispatchers and the Cmd+/ sheet read that subset, so the documented shortcuts cannot drift from the ones that fire. Nineteen key-carrying entries plus the keyless editor, git and right-panel-mode commands.
- **`scope` is the load-bearing field**, and it is what let Cmd+P join the table without a behaviour change:
  - `global` - routed through `dispatchHotkey`, which **both** `App.tsx`'s window listener and `TerminalView.tsx`'s `attachCustomKeyEventHandler` call. An xterm textarea's own key handling never lets a keydown reach `window` on its own, which is the entire reason the shared dispatcher exists.
  - `window` - window listener only, via `dispatchWindowHotkey`. **Cmd+P is deliberately here**: quick-open should not steal the key from a program running in the terminal. It used to live outside the dispatcher entirely to get that behaviour; the scope encodes it declaratively instead, and a test asserts `dispatchHotkey` returns false for Cmd+P while `dispatchWindowHotkey` returns true.
  - `terminal` - owned by the focused terminal, no table-level action. **Cmd+F is in the table with no `run`**: the focused xterm owns it and acts on one instance, so it cannot be a static action, but omitting it would make the sheet lie by omission. A test enforces that only terminal-scoped entries may lack an action.
- **`ShortcutSheet.tsx`** (Cmd+/): renders from `bindingsByGroup()`, read-only (remapping lives in Settings). Its Esc listener is **capture-phase**, for the same reason `dispatchHotkey` exists: a focused terminal swallows keydown before it bubbles, so a bubble-phase handler would leave the sheet undismissable from the most common focus state. It focuses itself on open and restores focus on close, because `aria-modal="true"` without moving focus is a claim the component does not honour.
- **`CommandPalette.tsx`**: a new sibling to `PickerModal` (not a reuse of it — `PickerModal` is single-select/string-only with no generic item/render-slot API), sharing its `fuzzyScore` util and `Dialogs.module.css` chrome. Lists two kinds of items: sessions and actions.
  - **Session "focus"**: every live session app-wide, sourced from [[concept_needs_you_floor]]'s Phase 1 status store (`liveStatuses()`), which already carries `tabId` + space/project context per entry. Selecting emits `FOCUS_SESSION_TAB {tabId}`, handled in `Terminal.tsx`.
  - **Session "resume"**: scoped to the *currently selected project only* (`list_sessions(props.selected.folderPath)`) — a full `Selection` needs space/project/branch context that can't be reconstructed from a bare session id, and only the sidebar's own tree walk has it. A resume-less adapter (`resume_args.length === 0`) degrades to `OPEN_TRANSCRIPT` instead of attempting `onSelect`.
  - **Actions**: new session per registered agent (`agents()`, not hardcoded claude/pi), right-panel mode toggles (`SET_RIGHT_MODE {mode}`, handled generically in `Editor.tsx`), open settings.
- **Does NOT** list every session across every space for "resume" — only "focus" (live sessions) has that reach, by construction (see above).

## The palette lists no sessions (2026-07-31)

Both session halves are gone (branch `navigation`, phase 7, commit 022d6b6).
`⌘K` is **actions only**: a new session per registered agent, right-panel modes,
view toggles, stop-a-running-chat, settings. It also lost its `onSelect` prop,
since nothing in it sets a `Selection` any more.

Why: [[component_history_dropdown]] is branch-scoped and lists *every* session
rather than only the live ones, which is more than a fuzzy line of text here
could say. The "resume" half's degradation path went with it - the resume-less
`OPEN_TRANSCRIPT` fallback died with the transcript viewer.

The rows gained `role="option"` inside a `role="listbox"`, with the filter field
and the empty state deliberately **outside** the listbox, since neither is a
selectable child. `CommandPalette.test.tsx` pins the negative: a live, named,
mid-turn chat in the selected folder produces exactly one row naming it (the
*stop* action), and `list_sessions` is never invoked.

## Key files & entry points

- `src/utils/commands.ts` - `COMMANDS`, the `Command` / `CommandGroup` / `CommandScope` / `Requirement` types. `commands.test.ts` asserts unique ids, that any entry with `keys` also has `match` and `scope`, that only a terminal-scoped entry may lack a `run`, and that the module's import list is exactly `["./events"]`.
- `src/utils/hotkeys.ts` - `BINDINGS` (derived from `COMMANDS`), `dispatchHotkey` (global only), `dispatchWindowHotkey` (global + window), `bindingsByGroup`, `GROUP_LABELS`. 12 unit tests in `hotkeys.test.ts`; they stub `window` via `vi.stubGlobal` because the suite runs in vitest's node environment.
- `src/components/ShortcutSheet/ShortcutSheet.tsx` - the Cmd+/ overlay.
- `src/panels/Terminal/TerminalView.tsx:177` — the `attachCustomKeyEventHandler` callback; calls `e.stopPropagation()` in addition to `e.preventDefault()` (see the linked gotcha — this is load-bearing, not decorative).
- `src/panels/Terminal/Terminal.tsx` — `TAB_JUMP`/`TAB_CYCLE`/`NEXT_WAITING_SESSION`/`FOCUS_SESSION_TAB` handlers, all operating on `tabsIn(ws)`/`open()`/`focusTab`.
- `src/components/CommandPalette/CommandPalette.tsx` — the palette component.
- `src/utils/events.ts` — `TAB_JUMP`, `TAB_CYCLE`, `NEXT_WAITING_SESSION`, `OPEN_PALETTE`, `SET_RIGHT_MODE`, `FOCUS_SESSION_TAB` event/type definitions.

## Connections

- Reads [[component_session_stores]]'s `liveSessionStatuses` for Cmd+Shift+A cycling (next-waiting). The palette itself no longer reads it.
- Reads [[component_editor_stores]] to resolve each command's `requires` tags into a refusal reason. It is the leaf of the import graph, which is exactly why that resolution happens here and not in the table.
- Superseded for session navigation by [[component_history_dropdown]].
- Emits into [[component_cm6_editor]] (`SET_RIGHT_MODE`, `FOCUS_PROJECT_SEARCH`) and [[concept_workspace_tab_grouping]] (`TAB_JUMP`/`TAB_CYCLE`/`FOCUS_SESSION_TAB`/`NEXT_WAITING_SESSION`).
- Broke the old Cmd+1 (`FOCUS_SEARCH`)/Cmd+2 (`FOCUS_TERMINAL`) bindings deliberately — a documented pre-v0.1 breaking change, not a regression.
- Shares [[component_picker_modal]]'s `fuzzyScore` util, and since #110 the same [[component_combobox]] surface and the same [[component_dialog]] shell. Still a separate component: the ranking and the row shapes are its own.

## Related

- [[concept_repository_identity]] - the rule the row labels obey, and the other four surfaces that obey it

- [[gotcha_xterms_custom_key_handler_return_value_doesnt_stop_dom_propagation]] — the double-dispatch bug this component's terminal-focus wiring has to defend against.
- [[gotcha_a_focused_xterm_swallows_keydown_before_window]] — why the sheet's Esc handler is capture-phase.

## Known gaps

- ~~The rendered sheet and its Esc handler were never exercised in a running app.~~ Closed 2026-08-02: the wave-1-4 app run opened Cmd+/ and confirmed the sheet lists the same keys the dispatcher fires, and `CommandPalette.test.tsx` now mounts the palette and drives a disabled row, key chips, and the close-before-run ordering.
