---
summary: review/ ranks sessions with unreviewed work by a fixed weighted sum in Rust; a mark is {ts, tree}, work since it is the session's own
status: current
updated: 2026-10-12
source: "Notifications inbox plan (gettori/tickets#36), commits b05df531, 814bc21c; Second opinion plan (gettori/tickets#34), commit 97a0a589; Conflict radar plan (gettori/tickets#33), commit e15376c2; Review inbox plan (branch `phase-1-block-2`, gettori/tickets#32); commits fb28a0fb, 6fe8ba85, d95439d9; `src-tauri/src/review/` (`mod.rs`, `paths.rs`, `scope.rs`), `src-tauri/src/checkpoint.rs` (`session_span`, `live_tree`), `src/utils/reviewInbox.ts`, `src/utils/reviewSignals.ts`, `mobile/src/Inbox.tsx`"
---

# Review inbox

`src-tauri/src/review/` lists sessions whose work nobody has read yet, riskiest first, for the desktop Inbox and the phone's cards.

## Responsibility

- **Listed** when the session is in a project, has a prompt after its mark, sits in a dirty or unpushed worktree, and its own diff since the mark is not empty. With no checkpoints, code turns since the mark stand in for the diff.
- **Marks** live in `~/.config/tori/reviewed.json` as `{ ts, tree }` per `ReviewUnit` key. `ReviewUnit` is an enum, so a PR can become a unit later. `installed_at` is every unmarked session's implicit mark, so an install starts empty without walking sessions. A corrupt file is set aside as `.bad` and lists everything rather than seeding.
- **Work since a mark** is `checkpoint::session_span`: the tree at the mark (or the checkpoint at or before `installed_at`) to `live_tree`, narrowed by the same complete, partial or unmeasured grading as `attributed_files` over every touched record since the mark. Diffs are cached by tree pair.
- **Score** is a fixed sum, each signal counted once with its count on the chip: secret read 30, failed 25, deleted tests 25, sensitive path 20, manifest 15, outside scope 15, blind edit 10, unverified 10, shared 10, base conflict 20, worktree overlap 15, lines `3*log2(n+1)` capped at 30. The last two come from `radar::session_signals`: conflicts from the radar's held answer for the session folder, else computed (an Inbox session may have ended, and nothing sweeps its folder), overlaps as the session's distinct files. Both are zero while the radar is off, and both score even without checkpoints.
- `paths.rs` classifies files (test dirs and names, manifests and lockfiles, CI, auth words split on camelCase, secret watch's `Rules::matches`). `scope.rs` reads path tokens from the first prompt and the branch's issue in `unit_issues.json`, prefixed with the folder's `--show-prefix`, cached once per session per run.

## Interface

- Tauri `review_inbox` and `review_mark`; RPC `review.list` and `review.mark` on `LOCAL_AND_DEVICES`, refused to every agent session. All four go through `inbox_now` and `mark_now`.
- `ReviewItem.second_opinion` is `second_opinion::opinion_of`: running, done with the open count and whether any is stale, or failed with the error.
- `mark_now` refuses while `SessionStates::running` (Working or NeedsYou, chat or PTY) and when a prompt arrived after the row's `to_ts`. It emits `review://changed` for the webview and publishes `session.reviewed` on the hub for the phone. It also calls `second_opinion::forget`, which drops the session's stored findings.
- The Inbox overlay (⌘⇧X, moved off ⌘⇧I, which is the editor's shrink selection) and the phone's Inbox screen have two tabs, Needs you and Review; they open on Needs you while it has unanswered rows, and the count bubble and the phone's bottom bar add those rows to the review count ([[component_needs_you_log]]).
- Frontend: `reviewInbox.ts` is the desktop store (it also refreshes on `radar://changed` and `second-opinion://changed`), `reviewSignals.ts` the pure types the phone shares. A row click sets `pendingReveal`, which the Changes panel and `CheckpointTimeline` consume once the turn is listed and the session is selected.

## Why it is this way

- **The mark stores the tree.** Checkpoint refs dedupe and are keyed by prompt start, so no ref holds the tree at review time; per-turn pairs cannot anchor a mark.
- **No mark mid-turn**, or later edits in the same turn fall under it unseen.
- **Scored in Rust**, so the Mac and the phone cannot rank differently.

## Related

- [[component_needs_you_log]] the Needs you tab beside this one
- [[component_turn_checkpoints]] the trees and attribution it diffs
- [[component_second_opinion]] the reviewer a row can start, and whose state it shows
- [[component_conflict_radar]] the base conflict and worktree overlap signals
- [[component_verification]], [[component_secret_watch]], [[component_blind_edit]] the turn signals it sums
- [[gotcha_two_writes_to_one_scratch_index_collide]] the race its live tree exposed
- [[gotcha_the_webview_is_not_a_hub_subscriber]] why a mark goes out on two channels
- [[gotcha_the_first_run_art_renders_the_phones_bottom_bar]] the prop that broke the push
- [[component_digest]] the Since you looked tab of the same Inbox
