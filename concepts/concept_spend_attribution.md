---
summary: the daemon records each live turn's spend stamped with repo, branch and item; issue and PR totals are derived at read time
status: current
updated: 2026-10-28
source: gettori/tickets#48 on branch cost-per-ticket, plan "Cost per ticket and per pull request, with a projection before queueing", commits 798e6f83, a72dc201, 6374485e, e0acfc08; src-tauri/src/chat/usage.rs:174 (record_live); src-tauri/src/chat/host.rs:209 (on_turn); src-tauri/src/rpc/daemon.rs:1000
---

# Spend attribution

Every turn a chat finishes is counted against the branch checked out when it ended and the autopilot item it worked for. Branch, item, issue and pull request totals are all read off those records; nothing is stored per issue or per PR.

## How it works

**Recorded once, in the daemon.** `Lifecycle::observe` calls the `OnTurn` hook on `TurnCompleted`, after its replay early return, so a history an ACP load hands back is never counted ([[gotcha_an_acp_load_hands_history_back_through_the_live_sink]]). Only the daemon sets the hook (`ChatHost::set_on_turn`, `src-tauri/src/rpc/daemon.rs:1000`), and only the daemon builds a serving `ChatHost`, so every chat is covered whether or not a window is open ([[gotcha_a_chathost_test_writes_the_real_usage_dir_if_it_records_directly]]).

**Stamped at record time.** `record_live` (`src-tauri/src/chat/usage.rs:174`) stamps the git common dir as `repo`, the current branch, the item (`rpc::item_for_spend`: a second opinion's reviewer maps to its parent first, then `item_for_session`), and the time. Each session keeps its totals plus `branches: {branch -> Spend}`, so a branch switch mid chat splits the spend instead of moving it. A detached head and every turn from before this shipped land in no bucket.

**Read from an in-memory index.** All usage files load into one index at first use (`index()`, `:221`), which only the daemon writes. `branch_total` (`:249`) matches repo and branch, so a deleted worktree's file still counts. `item_total` (`:259`) sums the sessions stamped with the item. `issue_total` (`:302`) counts a session of one of the issue's items whole and any other session only for its buckets on branches linked to the issue, so a session reached both ways counts once. A PR total is `branch_total` of its head branch.

**Told to the webview.** Each write emits `usage://changed` (`CHANGED_EVENT`, `:39`) with the session's and folder's totals; `ChatView` applies its own ceilings from that rather than from a write it made. The branch row, worker card and PR panel read through `spendFor` in `src/utils/spendStore.ts`, one batched `usage_spend` call refetched 50 ms after any change.

**ACP shows turns.** An ACP agent reports no money ([[concept_spend_ceilings]]), so its figure is turns with "no cost reported", never $0.00. `item_costs` (`:269`) leaves out any item one of whose sessions reported no cost, so a partial sum never passes for an item's cost.

## The projection

A proposed or queued item from an issue shows the median `item_costs` of its project's finished items in the same body size band (`autopilot::projection`, `src-tauri/src/autopilot.rs:1225`; bands under 500, under 2000, larger, in chars), once five exist. Failed items and items ever taken over (`Item.ever_taken_over`, sticky) never count. `body_len` is stamped once at creation: pickup reads it off the issue search, a hand-made item from one issue read when `AutopilotStore::new_issue_item` says the update makes it. Rejected: terciles (an item's band moves as history grows), refetching bodies at read time (forge rate budget), and the files an issue names (path extraction and a git walk per estimate).

## Related

- [[adr_spend_is_recorded_by_the_daemon_and_stamped_at_record_time]]: why it is recorded here and stamped this way
- [[concept_spend_ceilings]]: the ceilings these totals feed, the item ceiling included
- [[component_autopilot_store]]: the item fields the projection reads
- [[component_autopilot_watcher]]: the `over_ceiling` wake
