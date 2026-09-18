---
summary: wrapping an always-mounted For in a Show fallback unmounts the whole list when empty, killing every hidden process
status: current
updated: 2026-07-17
source: Per-workspace terminal sessions (personal/tori, branch `topbar`); `src/panels/Terminal/Terminal.tsx` (`.termStage` `<For>` + overlay `<Show>`); commit 0e671b1; see [[concept_workspace_tab_grouping]]
---

# An always-mounted For gated behind a Show fallback unmounts every row

Do NOT wrap an always-mounted `<For each={open()}>` (whose rows must survive, e.g. the terminal stage's `TerminalView`s) in a `<Show when={...} fallback={empty}>`; render the empty message as an **overlay sibling** shown by its own `<Show>` instead. Why: with per-workspace grouping the stage can have tabs open yet none visible (an empty active group, or every tab in a hidden group). If the empty condition gates the `<For>`, revealing that state makes Solid dispose the whole `<For>`, running each `TerminalView`'s `onCleanup` → `pty_kill` and SIGKILLing every hidden group's shell. The overlay coexists with the always-mounted (CSS-hidden) tabs, so nothing unmounts. This is the per-workspace corollary of [[gotcha_reordering_a_referentially_keyed_for_must_preserve_object_identity]].
