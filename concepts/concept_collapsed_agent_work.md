---
summary: collapseWork folds each run of thinking, calls, hooks and settled questions into one card at render time, blocking rows stay out
status: current
updated: 2026-10-02
source: plan "Collapse agent work into one line cards" (personal/tori, branch `performance-20261002`); `src/panels/Chat/toolRenderers.ts:208` (`groupRuns`), `src/panels/Chat/toolRenderers.ts:273` (`runLabel`), `src/panels/Chat/MessageList.tsx:685` (`WorkCard`), `src/panels/Chat/chatStore.ts:399` (`blocking`)
---

# Collapsed agent work

A chat setting, `chatDefaults.collapseWork`, off by default. On, the transcript reads as prompts and replies: everything the agent did between two replies is one line you may open, and opening it shows exactly the rows the transcript shows with the setting off.

## How it works

`groupRuns` (`src/panels/Chat/toolRenderers.ts:208`) walks the windowed items and gathers consecutive `thinking`, `tool`, `hook` and `question` rows into a run. A `user`, `text`, `command` or `notice` row ends the run and renders as itself. So a turn can hold several cards, one between each pair of replies.

A row the session is stopped on never joins a run. The test is `blocking` (`src/panels/Chat/chatStore.ts:399`): a tool in `awaitingApproval`, or an `answerable` question. It renders as it always has, and joins the card above it once it is answered, at which point the runs on either side of it merge. `visibleItems` uses the same predicate to show a subagent's prompt in the main lane, so one function answers both "pierces a lane" and "pierces a card".

`MessageList` iterates the grouped rows when the `collapseWork` prop is on and `shown()` when it is off, so off is the old DOM. The grouping memo returns null while the setting is off, because grouping reads every call's `state` through the store and would otherwise re-run on every settle in every mounted chat.

`WorkCard` (`src/panels/Chat/MessageList.tsx:685`) renders its members through the same `Row` component the list uses, inside a `Show`, so a shut card mounts no tool cards or diffs. It also renders the `TurnAnchor` of any member that opens a turn, and tells its rows to skip theirs: a turn usually opens on a thinking or tool row, and scroll restore and the model line both hang off that anchor.

The label comes from `runLabel` (`src/panels/Chat/toolRenderers.ts:273`). Settled, it counts: "8 tool calls, 1 question, 2 hooks", plus ", 1 failed" in the danger tone for a call in `error` or a hook where `hookFailed`. A run of thinking alone says how long it thought. While the run is the streaming tail it names its last member whatever state that is in, with the thinking sheen.

## Why it is this way

- **Text is output, everything between texts is a card.** The first idea was to show only a turn's final text. That text cannot be identified until the turn ends, so the live view would have needed a different shape and a layout jump at the end. Cutting at every text needs neither, and the narration between calls is the cheap way to know what a shut card did.
- **The card wraps the rows, it does not hide them.** `foldEdits` hides rows with an id set, which works because a folded edit has one other place to show. A hidden set here would need a second render path for the open card, and the two would drift.
- **A pending prompt renders outside the card, not by forcing the card open.** Forcing it open shows every row of the run to surface one prompt.
- **Failures are a count, not a breakout.** With `showToriHooks` off, the only hook rows that reach the list are failed ones, and a hook on a session event (`Stop`, `UserPromptSubmit`) is a run of its own, which is why `runLabel` has an "N hooks" part. This does make a lone failed hook quieter than its old red row with stderr.
- **Hooks are counted by `hookId`.** One execution is a `started` row and a `finished` row.
- **The inline switch in the status strip menu writes the global setting.** A per chat override would be a second source of truth with an open question about which wins after a restart. The cockpit and an unstarted chat have no menu and follow the setting.
- **Open state is local to the card and not persisted.**

## Related

- [[component_chat_panel]] the panel this lives in
- [[gotcha_a_run_keyed_by_its_first_member_remounts_as_the_window_slides]] why a run's identity follows its members
- [[gotcha_reordering_a_referentially_keyed_for_must_preserve_object_identity]] the `For` behaviour the run cache exists for
- [[gotcha_a_factory_returning_jsx_freezes_a_row_built_from_a_store_object_mutated_in_place]] why `Row` and `WorkCard` are components
- [[gotcha_a_chatdefaults_key_has_five_homes_and_only_one_of_them_fails_loudly]] where the setting lives
- [[concept_inline_agent_question]] the question row that joins a card once answered
- [[concept_subagent_lanes]] the other user of `blocking`
