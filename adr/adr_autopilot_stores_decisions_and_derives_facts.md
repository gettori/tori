---
summary: autopilot state stores only what a model decided; facts are derived per read, so a restart can't rewrite a state
status: current
updated: 2026-09-24
source: gettori/tori#204 on branch orchestrator, plan "Autopilot state on disk"; commits 424a5d26, 29293fe2, 280f72e8; src-tauri/src/autopilot.rs; src-tauri/src/rpc/asks.rs
---

# The autopilot stores decisions and derives facts

## Context

Killing Tori mid-task and relaunching must give the autopilot back the same queue. But no chat child survives a relaunch, so on the next read every `running` item has a dead session. Approval asks from #203 lived only in memory and went away with their chat. Git and the forge already know which worktrees exist and which PRs merged. `attempts.rs` had already set the rule: git is the truth, and the file holds only what git can't say.

## Decision

- The store keeps only what the autopilot decided: items, their states and notes, and project contracts. Whether an item's session is live and whether its worktree is gone are derived on every read (`session_live`, `worktree_gone`) and never stored.
- A merged pull request is the one fact a read writes back: the item goes to `done`, and its holds are withdrawn.
- Holds are the existing approval asks, made persistent: `ask.create` with an `item`, written through to `holds.json` by `Asks`. The user still approves on the card. `autopilot.hold.resolve` only withdraws.
- `autopilot.item.update` without an id creates the item, matching an open item on (kind, source, project), so the retry after a crash cannot make a second one. There is no `autopilot.item.add`.
- The files are global under `~/.config/tori/autopilot/`, since one autopilot spans projects.

## Alternatives rejected

- **`running` becomes `failed` when its session is gone**: every relaunch would destroy state, since no chat child survives one.
- **A stored `interrupted` state**: one more state for the watcher to clear, standing in for a fact that can be read directly.
- **A separate hold store with its own resolve path**: it would copy the draft binding and open a second way to approve, next to the card.
- **Reusing the forge's open-only status cache for merges**: it can't tell a merge from a close.
- **Per-project store files (`project_state_path`)**: the autopilot works across projects, so its queue is one list.

## Consequences

- A restart changes nothing stored. A `running` item reads `session_live: false` until its tab resumes, and the autopilot decides what that means.
- A grant lived only in the old process, so an Approve nobody had read is asked again after a restart or chat end. A Reject nobody had read still goes to the next `ask.wait`.
- Every read may cost a forge call, which is why the lookup is batched per repo, cached for 30 s and run outside the store lock.
- A PR closed without merging gets a note, not a state of its own.

## Related

- [[component_autopilot_store]]: the implementation
- [[adr_autopilot_is_a_session_not_a_state_machine]]: judgment lives in the session, and this is its memory
- [[adr_a_background_session_needs_a_tori_gate]]: the approval asks that holds persist
- [[component_app_socket]]: `Asks` and the `autopilot.*` methods
