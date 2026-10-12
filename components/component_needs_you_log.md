---
summary: needs_you_log keeps what needed you plus the digest's facts in Rust, rows reconciled each composition, answered on clear or on look
status: current
updated: 2026-10-12
source: "Notifications inbox plan (branch `phase-1-block-2`, gettori/tickets#36); morning digest plan (gettori/tickets#37, commits abaeddaa, 52202880); commits 27dc9364, b05df531, 814bc21c; `src-tauri/src/needs_you_log.rs`, `src-tauri/src/rpc/mod.rs` (Composer::present), `src/utils/needsYouInbox.ts`, `src/utils/needsYouSignals.ts`, `src/utils/pendingCard.ts`, `mobile/src/Inbox.tsx`"
---

# Needs-you log

`src-tauri/src/needs_you_log.rs` keeps what needed you, for the Inbox's Needs you tab on the Mac and the phone, and the facts the Since you looked digest reads ([[component_digest]]). A notification is taken down once the session moves on, so this is the list that survives.

## Responsibility

- **Kinds.** `permission`, `question`, `budget`, `waiting` (a PTY tab, which only shows it is blocked), `workerQuestion` (a question whose spawner relays it), `done`, `pullRequest`. The first five come from `Live.reason` ([[component_presence]]); a forge raise is never a block row.
- **`log_ops` reconciles, it does not just follow edges.** Each composition compares the live sessions with the log's open rows: a blocked session with no open row of the same block gets one, an open block whose session is no longer blocked (or gone) is answered, and a reason change while still NeedsYou (approval to question) answers the old row and adds a new one. Presence's `rose` and `cleared` cannot see a reason change, and a restarted Presence has no edges for rows left open.
- **Finished turns** come from Presence's `finished` edge. A relayed worker's adds no row; one finished while watched is logged already answered.
- **Pull requests** follow each forge unit's `attention` rising edge, keyed by folder and branch, never the dot ([[gotcha_a_forge_raised_dot_rises_again_after_every_turn]]). `settled` marks a row whose attention fell, so the next red check is a new row and a row answered by looking does not come back while the check stays red. `attention` is a red check or changes requested, hence "Pull request needs attention".
- **Answered** means `resolved_at` is set. A block by its session moving on. A finished turn or a pull request by being watched (`Presence::suppressed`: selected in a focused window, or a chat whose tab is visible, so a chat counts without its id ever being selected) or by `seen`. `seen` narrows pull request rows by branch when it is known, since a plain repo's branches share one folder.
- **Digest-only kinds.** `prOpened`, `prMerged`, `limitHit`, `limitResumed` are born answered and filtered out of `needs_you.list` (`Log::needs_you`), so neither client's Needs you tab or badge sees them. `blocks()` is an allow list of the five block kinds, so a new kind is never a block by accident.
- **Pull request memory.** `prs` keeps each unit's last seen pull request (number and state, or none) by folder and branch, across restarts, so a merge while Tori was shut is a `prMerged` row after launch. A unit seen for the first time only seeds. A unit whose forge has not answered (`pr_known` false) is skipped, so an unpolled space never reads as "no pull request". Open entries are kept 30 days, others 7, since losing an open one makes its merge read as a first sighting.
- **Limits.** `note_limit` adds one row per account and reset (`limit-hit:agent/profile:resets`), so every chat of one login stopping at one reset is one row, opening the first chat that stopped.
- **The mark and verdicts.** `looked_at` is when the digest was last seen, moved only by `looked` and never back ([[adr_the_digest_mark_moves_only_when_the_digest_was_seen]]). `verdicts` keeps each session's latest live verification verdict, noted by the chat host, so it survives a relaunch.
- **Storage.** `~/.config/tori/needs_you.json`, written atomically, pruned on every access: a row stays a day, or back to `looked_at` up to 7 days. `needs_you.list` still serves only the last day. Loaded once per run, and the load answers every open row: the presence that could clear it died with the last run, and a session still blocked raises a fresh row on the first tick. A corrupt file is set aside as `.bad`.

## Interface

- Tauri `needs_you_list`, `needs_you_seen(session?, folder?, branch?)`; RPC `needs_you.list` and `needs_you.seen` on `LOCAL_AND_DEVICES`, refused to agent sessions.
- Changes go out as `needs-you://changed` for the webview and `{ kind: "needs_you.changed" }` on the `sessions` hub channel for the phone.
- Desktop: `needsYouInbox.ts` is the store, `needsYouSignals.ts` the types and grouping both clients share. A row click calls `needs_you_seen`, navigates, and for an open block on a chat sets `pendingCard`, a held signal the chat view consumes once its state has loaded to scroll the `[data-pending-card]` approval or question into view.
- Phone: `watchNeedsYou` in `mobile/src/Inbox.tsx`. Pending cards are docked above the composer there, so opening the chat is landing on the card. Every chat screen opened calls `needs_you.seen` with the row's home folder and branch.

## Why it is this way

- **In Rust beside presence**, so the Mac and the phone list the same rows and #37's digest can read overnight events.
- **The card reveal is held, not a `NavTarget` field**, because a chat tab may mount after the navigation, the same reason `checkpointReveal` is held.

## Related

- [[component_presence]] the edges and `Live` it reads
- [[component_review_inbox]] the other tab of the same Inbox
- [[component_digest]] the Since you looked tab that reads this log
- [[concept_in_app_navigation]] how a row opens its session
- [[gotcha_the_webview_is_not_a_hub_subscriber]] why changes go out on two channels
