---
summary: secret reads are classified once in Rust as chat events leave and again at replay, then rolled up per turn for tabs and Checkpoints
status: current
updated: 2026-10-08
source: "Secret watch plan (branch `phase-1-block-1`, gettori/tickets#28), phases detect-and-mark-turn and row-and-checkpoints; commit 11e0b12d; `src-tauri/src/secret_watch.rs`, `src-tauri/src/chat/host.rs` (`wrap`, `mark_secrets`), `src-tauri/src/chat/commands.rs` (`session_secrets`), `src/utils/secretReads.ts`"
---

# Secret watch

**Location:** `src-tauri/src/secret_watch.rs` (matcher, classifier, per-turn rollup, cache), `src-tauri/src/chat/host.rs` (`wrap`, `mark_secrets`), `src-tauri/src/chat/commands.rs` (`session_secrets`), `src/utils/secretReads.ts` (live session store), `src/panels/Chat/MessageList.tsx` and `ToolCallCard.tsx`, `src/panels/Terminal/TabMark.tsx`, `src/panels/Editor/CheckpointTimeline.tsx`

A turn in which an agent opened, or a command named, a secret-shaped file is marked. A fact on the turn, never a gate: nothing is blocked or asked.

## How it works

- **One classifier, two strengths.** `classify` reads a `ToolCallStarted`'s normalized `kind`, `input` and `locations`, so Claude and ACP go through the same code. `Read`/`Search` kinds give `read` (`Glob` excepted, it opens nothing). An `Execute` command is split on whitespace, quotes, parentheses and `;&|<>=,[]` backticks, and any matching word gives `named`. `$`, `{` and `}` stay inside words so `$HOME/.aws/x` still expands. See [[concept_evidence_tiered_attribution]] for why the two claims are worded differently.
- **The list.** Basename rules (`.env`, `.env.*` unless the last segment is `example`, `sample` or `template`, `*.pem`, `*.key`, the four `id_*` key names, `credentials`, `credentials.json`, `.netrc`), everything under `~/.aws/` and `~/.config/gh/`, and extensionless files under `~/.ssh/` except `config`, `known_hosts`, `authorized_keys`. `*.pub` never matches. Relative paths resolve against the session cwd and are normalized lexically, never through symlinks.
- **Where events are marked.** Live: `ChatHost::wrap`, before the mirror log, the socket publish and the UI, so the phone feed and the ACP log carry it. Replay: `ChatHost::mark_secrets`, next to `cut_outputs` in `history_reply` and `chat_history_page`, recomputed against the list as it is now. See [[gotcha_a_change_to_live_chat_events_misses_replay]].
- **Per turn, for surfaces without tool cards.** `session_secrets(sessionId, agentId, cwd)` runs the classifier over `read_with_prompts`, so a subagent's read lands in its launching turn. An ACP log has no prompts and groups by turn id with `promptTs: null`, which is why Checkpoints marks are Claude only. Cached by session id plus cwd, keyed on the newest mtime of the transcript and its subagent files and the settings.json mtime.
- **Live surfaces.** `secretReads.ts` watches every live session: tabbed ones and those running with no tab (the History open-now group lists both). It asks when a session appears or its status moves, on `settings://changed`, and on `sessions://changed` only for the folders the event names. A session that stops being live drops its mark. The tab wears a small key on the opposite corner from the needs-you badge; the History row reuses `TabMark`.
- **Settings.** `secretWatch.enabled` (default on, the Chat pane's "Mark secret file reads" row) and `secretWatch.patterns` (hand-edited only, additions only). The block deserializes leniently because `load_from` has no per-section recovery. `keep_rust_owned` keeps the file's `patterns` but takes the panel's `enabled`. Off builds `Rules::off()`, so every Rust answer goes empty, and `MessageList` hides marks an open chat already holds.

## Why it is this way

- Detection is in Rust rather than in `applyEvent` so PTY sessions, closed panels and windowless sessions are covered by the same code.
- The settings cache keys on mtime rather than a watcher, so an added pattern applies with no relaunch and the same stamp invalidates the per-turn cache.
- The workspace overlay cannot touch the list: a repository must not be able to narrow what Tori watches.

## Related

- [[concept_evidence_tiered_attribution]] the read versus named wording
- [[component_blind_edit]] the stateful sibling that reuses `shell_words`, `normalize`, `expand` and `command_text`
- [[gotcha_a_change_to_live_chat_events_misses_replay]] why marking happens in two places
- [[component_history_dropdown]] the row that reuses the tab's mark
- [[component_turn_checkpoints]] the timeline whose turn rows carry the key
- [[lesson_a_plan_names_a_mechanism_the_code_forbids]] the per-session sidebar row the plan assumed
