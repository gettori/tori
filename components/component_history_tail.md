---
summary: chat/tail.rs cuts the open tail and its pages, foldHistory seeds from the summary, prependHistory merges a page in front
status: current
updated: 2026-10-04
source: "Open a chat with a bounded tail of history (personal/tori, branch `open-chat-with-bound`), ticket gettori/tickets#5; `src-tauri/src/chat/tail.rs`, `src-tauri/src/chat/commands.rs` (`chat_history`, `chat_history_page`, `read_tail`, `read_page`), `src/panels/Chat/chatStore.ts`; commits b714844c, 299b6022"
---

# History tail

`src-tauri/src/chat/tail.rs` plus `foldHistory` and `prependHistory` in
`src/panels/Chat/chatStore.ts`: how a claude chat opens on part of its history
and pages the rest in. The decision is [[adr_chat_opens_on_a_bounded_tail]].

## Responsibility

- **The cut.** `tail_of(events, prompts, end)` walks back counting row-making
  events (user message, text, thinking, tool call start, local command,
  compaction) until 75, or until the floor of 60 is held and 1 MiB is spent.
  Bytes are measured as they will cross, with tool output already through
  `cap_output`. The cut then moves forward to the first turn boundary that still
  keeps the floor; a turn too big for the budget is cut at a row. A subagent's
  rows count too, so the main lane can open with fewer than 60.
- **The summary**, of the events before the cut only: compaction count and
  reclaimed tokens, the last compaction's context tokens, attachment labels, the
  subagent frames (`subagentStarted`, `subagentCall`, `subagentUpdate`), and
  what the panel counts off rows: prompts, main-lane tool calls, main-lane
  `AskUserQuestion` calls kept apart, and touched paths. A call the tail also
  touches is left for the tail to count.
- **The cursor**, `HistoryCursor { promptTs, offset }`: the prompt whose turn the
  cut falls in, by transcript timestamp, plus an event offset into that turn.
  Never an index ([[gotcha_replay_turn_ids_shift_between_two_reads]]).
- **Pages.** `chat_history_page(sessionId, fromSessionId, agentId, cursor)` takes
  the same source arguments as `chat_history`, so a fork pages the transcript it
  forked from. Parses live in an LRU of 3 keyed by reader session plus
  transcript path (events are stamped with the reader's id), stamped by the
  jsonl's mtime and length. The open never fills it.
- **The webview fold.** `foldHistory` seeds the store from the summary, folds
  the lane frames and the tail, and returns every label for `seedLabels`. The
  unloaded counts sit in `ChatState.unloaded`; `promptsSent`, `toolCallsSeen` and
  `ChatView`'s `touchedFiles` add them.
- **The merge.** `prependHistory` folds a page into a scratch state and splices
  it ahead ([[gotcha_apply_event_only_appends_so_older_rows_merge_in_front]]).
  A call declared in the page and completed in the tail becomes one card at the
  declaration; a question likewise takes its answer from the tail's nameless
  card. Figures and lanes are left alone; `unloaded` gives up the page's share
  so the totals stand.
- **Load earlier.** `MessageList`'s `onFetchEarlier` fires once every loaded row
  is shown. `ChatView` keeps one page in flight and drops a response whose
  cursor moved. The list holds the reader from the bottom while rows land
  above, only while the old first row is still shown.

It does **not** bound ACP chats (their log comes back whole) or read only the end
of the file: Rust parses the whole jsonl every time.

## Tests

`historyTail.golden.json` is written by the `chat::tail` tests with
`TORI_BLESS=1` and read by `historyTail.test.ts`, which folds each history whole,
as summary plus tail, and as tail plus every page, and asserts the figures,
labels, rows and index maps agree. A fold rule changed on either side fails it.
`Lane.startedAt` is `Date.now()` at fold, so the test pins the clock.
`pagedHistory.test.tsx` drives "load earlier" through `ChatView` with stubbed
scroll boxes.

## Related

- [[adr_chat_opens_on_a_bounded_tail]]: why
- [[component_chat_panel]]: where it is folded and shown
- [[component_chat_host]]: `cut_outputs`, applied to tails and pages alike
- [[component_perf_trace_harness]]: the `chat-open` row
