---
summary: a claude chat opens on a 75 row tail plus a Rust summary, older history by cursor; chunked fold and full load rejected
status: current
updated: 2026-10-04
source: "Open a chat with a bounded tail of history (personal/tori, branch `open-chat-with-bound`), ticket gettori/tickets#5; `src-tauri/src/chat/tail.rs`, `src/panels/Chat/chatStore.ts` (`foldHistory`, `prependHistory`); commits b714844c, 299b6022"
---

# A chat opens on a bounded tail of its history

## Context

`chat_history` used to parse the whole transcript and return every event, and
the webview folded all of them in one `edit` on the main thread. Rendering was
already bounded (`MessageList` windows 60 rows), the read, the payload and the
fold were not. Measured on 2026-10-04 with release probes on real transcripts:

| events | payload | read (blocking pool) | parse | fold |
| --- | --- | --- | --- | --- |
| 9521 | 9.9 MB | 160 ms | 18 ms | 72 ms |
| 12702 | 15.3 MB | 185 ms | 28 ms | 96 ms |

One open of one chat is a 100 ms hitch. What made it worth fixing is the many
session case: a reload reattaches every chat tab ([[adr_lazy_tab_attachment]]),
so the folds add up per tab, and every mounted chat kept its whole history in
the reactive store for the rest of the run. Event count predicts the cost, file
size does not (a 114 MB transcript of 1934 events folds in 18 ms).

## Decision

A claude chat opens on a tail: the last 75 row-making events, never fewer than
the 60 the panel shows, with 1 MiB as a soft cap above that floor, cut at a turn
boundary when one fits. Rust builds a summary of everything before the cut in
the same parse, so it cannot lag ([[gotcha_a_figure_re_read_from_a_file_lags_the_event_that_triggered_the_re_read]]).
"Load earlier" fetches older pages by a cursor and merges them in front. The
mechanism is [[component_history_tail]].

## Alternatives rejected

- **Leave it.** Rendering was bounded and one open is 100 ms. Rejected for the
  reload and memory case above, not for the single open.
- **Chunked fold** (fold the full payload across frames). Removes the freeze but
  spends the same CPU per reload and leaves memory unbounded.
- **Figures-only fold in the webview.** One reducer, but the full payload still
  crosses IPC and is parsed on the main thread.
- **Persisted snapshot of the figures.** Tiny open, stale whenever the CLI ran
  outside Tori.
- **A Rust copy of the reducer for the summary.** Not needed: replay emits only
  ten event kinds, and what they leave past the cut is a few counters, the label
  seed, touched paths and the subagent frames, which make no rows and are
  folded as they are by the one reducer.
- **An index cursor.** Moves between reads ([[gotcha_replay_turn_ids_shift_between_two_reads]]).
- **Caching the parse of every open session.** After a reload that is every
  tab's full history again, just in Rust. The cache is an LRU of 3, filled on
  the first page request.

## Consequences

- Opening a long chat folds a bounded tail, and mounted chats no longer hold
  their whole history.
- Rust still parses the whole jsonl, about 160 ms per big chat on the blocking
  pool. A true tail read or a parse cached across runs would be its own ticket.
- "Load earlier" is a fetch now; a page after the file changed re-parses.
- ACP chats are unbounded: `session/load` replays the whole conversation through
  the live sink ([[gotcha_an_acp_load_hands_history_back_through_the_live_sink]]),
  so `chat_history` returns their log whole with no cursor.
- The session diff view needed nothing: it spans this run only
  ([[lesson_check_what_a_reader_does_with_a_field_not_that_it_takes_it]]).

## Related

- [[component_history_tail]]: the mechanism
- [[component_chat_panel]]: the panel that folds it
- [[component_perf_trace_harness]]: the `chat-open` row that measures it
- [[gotcha_apply_event_only_appends_so_older_rows_merge_in_front]]: why a page is merged, not folded
