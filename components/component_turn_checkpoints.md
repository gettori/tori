---
summary: a git write tree snapshot per prompt boundary, keyed by timestamp not a counter, powers per turn diff and tree revert
status: current
updated: 2026-07-31
source: "Adapter registry, pulse, presence, checkpoints (personal/sway, branch `topbar`); Phase 4; `src-tauri/src/checkpoint.rs`; Status deepening: checkpoint timeline, tree revert, touched markers, live indicator (personal/sway, branch `main`); Phase 1; `src/panels/Editor/CheckpointTimeline.tsx`, `src/utils/revertGuard.ts`; Chat surface plan, phases 1, 3, 5 (branch `chat`)"
---

# Turn-level checkpoints

**Location:** `src-tauri/src/checkpoint.rs`, `src/utils/checkpoints.ts`, `src/utils/revertGuard.ts`, `src/panels/Editor/CheckpointTimeline.tsx` (timeline + tree revert), `src/panels/Editor/TranscriptViewer.tsx` (per-turn diff/revert UI), `src/panels/LeftSidebar/LeftSidebar.tsx` (trigger + pruning wiring), `src/panels/Settings/{Settings,settingsStore}.ts` (the `checkpoints.enabled` toggle)

A snapshot of the full working tree at each prompt boundary, so a session's turns can be diffed and reverted from ground truth — the tree itself — rather than the transcript's account of what it did. This closes the gap where Bash-driven writes (`sed`, redirects, codegen) are invisible to path-argument parsing: the snapshot delta doesn't care *how* a file changed.

## Responsibilities

- **Snapshot mechanism** (`checkpoint.rs`'s `checkpoint_snapshot`): `git add -A` against a **persistent per-session scratch index** (`~/.config/sway/checkpoint-index/<sessionId>`, kept warm across snapshots for git's stat cache — the same trick `/gg`'s own baseline refs use), then `write-tree`. Never touches the user's real index or staging. No-op outside a git worktree.
- **Ref naming is keyed by prompt timestamp, not a sequential counter**: `refs/sway/checkpoint/<sessionId>/<promptTs>`, where `promptTs` is the triggering human message's transcript timestamp. See [[lesson_checkpoint_refs_keyed_by_timestamp]] for why a counter doesn't work here.
- **Dedup**: a computed tree identical to the nearest earlier checkpoint creates no new ref (an idle turn, or a duplicate trigger call, doesn't bloat the ref list). A ref already present at the exact `promptTs` is left alone (idempotent re-trigger).
- **Prompt-boundary trigger** (`sessions.rs`'s `session_prompt_tail`, `src/utils/checkpoints.ts`): reuses `is_human_prompt` (the same filter `session_detail`'s `prompt_count` uses) to return `{count, last_ts}` per session, agent-agnostic. `checkpoints.ts` mirrors `presence.ts`'s pure-state-machine shape (`stepCheckpointTrigger`) — fires on any rise in `count`, including a session's very first prompt (that boundary must be captured *before* the first turn's edits land). Wired into `LeftSidebar.tsx` alongside the existing tail-state polling, gated by `settings.checkpoints.enabled` (default on).
- **Per-turn diff** (`checkpoint_turn_files`/`checkpoint_diff_file`): resolves "before" as the nearest checkpoint at-or-before a turn's `promptTs`, "after" as the nearest checkpoint strictly after it — or, for the latest/still-open turn (no next prompt yet), a **live, unpersisted** snapshot via the same scratch index, so an in-progress turn's diff stays current without waiting for the next prompt.
> **2026-07-31:** `TranscriptViewer` is gone (branch `navigation`, phase 7), so the per-turn diff/revert UI described below no longer has that home. The **commands are untouched** (`checkpoint_turn_files`, `checkpoint_diff_file`, `checkpoint_revert_file`) and the Changes-panel timeline still drives them; what was lost is the turn-row surface. Re-homing it is unclaimed work.

- **Per-file revert** (`checkpoint_revert_file`): resolved from the same before/after tree pair — present only in "after" (added this turn) → delete; present in "before" (edited, or deleted this turn) → restore the pre-turn blob via `git show <before-tree>:<file>`. `TranscriptViewer`'s confirm dialog states the exact action per file (from `CheckpointFile.status`) before the user commits.
- **UI surface**: landed in `TranscriptViewer`'s turn rows only, not duplicated in `SessionPanel` — see the "why" below. A shared-workspace label ("changes in this workspace during this turn") replaces "changes this turn" when more than one live agent tab shares the turn's `repoPath`.
- **Timeline listing** (`checkpoint_list`): ordered turn checkpoints with prompt timestamp, per-turn file count, and approximate size (one `--raw` diff per turn for both count and blob ids, sized afterwards in a single batched `cat-file`). Returns `Vec<CheckpointEntry>`; a non-repo folder returns **empty, not an error**, so the timeline simply does not render there. `list_checkpoints` returns a `Checkpoint { ts, tree, kind }` struct (was a tuple) so the backstop kind rides along.
- **Whole-tree revert** (`checkpoint_revert_tree`): snapshots the current tree as a new labeled **backstop** checkpoint *first*, then restores the working tree to the target checkpoint's tree via the same scratch-index pattern (untracked files included, gitignore respected). Returns a `RevertOutcome { restored, deleted, backstop_ts }`; `backstop_ts: null` means the tree already matched, so nothing was reverted. The **index is never touched**, so staged content survives even when the worktree file is reverted — a narrower guarantee than it first appears, and the one the tests assert (`git diff --cached` plus `git show :file`, not file content).
- **Backstop labeling rides on the ref name** (`refs/sway/checkpoint/<sid>/<ts>.backstop`), so the timeline marks it with no side table. Its timestamp must be epoch **seconds** to sort correctly against real boundaries — see [[lesson_synthetic_test_values_hide_unit_bugs]].
- **Revert liveness guard** (`src/utils/revertGuard.ts`, pure + unit-tested): the mechanical revert is backend-only; the *decision* is frontend, because "Executing" is composed there from PTY activity plus transcript tail and the backend cannot see it. Two tiers (Executing = hard block, detached = overridable) — see [[concept_evidence_tiered_attribution]].
- **Buffer-conflict resolution**: revert outcomes are pushed to `CodeEditor` directly (`reverted={paths, nonce}`) rather than relying on the fs watcher, so a destructive action's buffer consequences never depend on watcher timing or coalescing. Clean buffers reload; dirty buffers get keep-mine / take-disk; a **deleted** variant covers files the revert removed (keep-mine → dirty against an empty baseline so recreation is explicit; take-disk → close the tab). The deleted case fires for clean buffers too, since a clean buffer can still be saved and would silently recreate the file.
- **`cumulative`** was added as `Option<bool>` on `checkpoint_turn_files`/`checkpoint_diff_file`, so existing `TranscriptViewer` call sites keep working unchanged. The cumulative timeline view is labeled **"workspace since here"**, never presented as this session's own changes — it diffs the checkpoint tree against the working tree, so user edits and other sessions' work are inside it.
- **Pruning** (`checkpoint_prune`): removes every `refs/sway/checkpoint/<sessionId>/*` ref and the session's scratch-index file. Wired into `LeftSidebar.tsx`'s `deleteSession` (always) and `archiveSession` (only on the archiving transition, not on restore).

## Key files & entry points

- `src-tauri/src/checkpoint.rs:159` — `checkpoint_snapshot`.
- `src-tauri/src/checkpoint.rs:230` — `checkpoint_turn_files`.
- `src-tauri/src/checkpoint.rs:264` — `checkpoint_revert_file`.
- `src-tauri/src/checkpoint.rs:359` — `checkpoint_list` (empty for a non-repo folder).
- `src-tauri/src/checkpoint.rs` — `checkpoint_revert_tree` (backstop-then-restore).
- `src/panels/Editor/CheckpointTimeline.tsx` — the turn strip, cumulative toggle, revert confirm + blast-radius message.
- `src/utils/revertGuard.ts` — `revertBlockers` / `revertGuard` (pure, unit-tested).
- `src-tauri/src/sessions.rs` — `session_prompt_tail` (`PromptTail{count, last_ts}`).
- `src/utils/checkpoints.ts` — `stepCheckpointTrigger`, `noteCheckpointTicks`.
- `src/panels/Editor/TranscriptViewer.tsx` — the per-turn "Changes this turn" expandable row, revert confirm dialog.

## Connections

- Depends on [[component_agent_adapter_registry]] indirectly — the trigger's `session_prompt_tail` dispatches through the same agent-agnostic transcript parsing the registry drives, but checkpoints themselves observe the working tree, not agent-specific transcript shape.
- Depends on [[component_session_worklog]] — hosted inside `TranscriptViewer`, the virtual-tab surface that component created; `OpenTranscript`/`TranscriptTab` gained a `cwd` field to carry the repo path down to this feature.
- Settings: [[component_settings_store]]'s `Settings.checkpoints.enabled` (default on) is this feature's off switch.

## Why it's this way

**Why `TranscriptViewer` only, not `SessionPanel` too**, even though the plan named both: `SessionPanel` is file-centric across the *whole* session (backed by `session_touched_files` + a diff against HEAD), while checkpoints are inherently turn-centric. Retrofitting turn structure onto `SessionPanel` would have been a materially bigger rework than this task's scope, and `SessionPanel`'s existing collision badges already surface a shared-workspace signal for the aggregate view. `TranscriptViewer`'s turn rows are the literal, natural home.

**Accepted tradeoffs, not fixed**: the empty-tree sentinel is the well-known SHA-1 hash (`4b825d...`), so a SHA-256 repo's very first turn would misresolve "before" — vanishingly rare among this app's users today. Two human prompts landing in the same wall-clock second would collide on one ref (timestamps are second-resolution) — not achievable by actual typing.

## Per-turn attribution under concurrent chats (2026-07-28)

The snapshot is a whole-tree `git add -A`, which was exact while a worktree had at most one live agent and stopped being so when several chats could share one: two sessions editing in the same interval each saw the other's files in "changes this turn", because a tree cannot say who wrote what.

Chat supplies the missing fact rather than an approximation - `ToolCallCompleted` reports **exactly** which paths a session wrote. Those sets are recorded per `(session, turn)` under `~/.config/sway/checkpoint-touched/` and intersected with the tree diff, with overlaps surfaced as `shared_with` rather than hidden. Load-bearing detail: a turn with **no recorded set is not filtered**, because an empty set there means "not measured" (a PTY session, or any turn predating attribution) and never "wrote nothing" - filtering on it would silently blank every historical turn's file list.

## Two new consumers, and a stored attribution state (2026-07-29)

The checkpoint refs stopped being only a revert mechanism.

- **Rewind** reverts the tree to a chosen turn's checkpoint as one third of
  [[concept_rewind_by_fork]] (fork the session, revert the tree, announce what
  did not go back). Rewind is offered only on turns *this tab ran*, because only
  those have a checkpoint: a replayed turn's tree state was never recorded, so
  offering it would fail at the revert with nothing having warned it might.
- **The diff-as-transcript view** ([[concept_diff_as_transcript]]) joins against
  the session's first and last checkpoint to check its accumulated per-file diff
  against `git diff` between those two trees.
- **`checkpoint_note_touched` now records tools as well as paths**, so a turn can
  say it ran something whose writes no path parse would catch. See
  [[concept_evidence_tiered_attribution]] for the grading that state feeds, and
  the revert refusal it enables.

A trap worth naming for anyone joining a cheap timestamp off these refs:
`checkpoint_list` looks like the way to ask "when did this session start", and
its own comment admits it costs a `git diff --raw` per checkpoint plus a
write-tree, so a 200-turn session would fire roughly 200 git invocations to get
one number. `ChatView` already knows it and passes it down.

## A sibling ref family, and a third consumer (2026-08-02)

Editor wave 2 added [[concept_worktree_backstops]] beside these rather than inside them: pre-destruction snapshots for actions with no session and no prompt boundary, owned by a **worktree identity** instead of a session id. They share the scratch-index snapshot pattern and the timeline that renders them, and nothing else. `list_checkpoints` returns a `Checkpoint { ts, tree, kind }` so the kind rides along, and the timeline's render gate widened from `sessionId && entries().length` to include `backstops().length`, since a backstop can exist in a worktree with no session at all.

The touched-index also gained a **reverse** direction. `checkpoint_note_touched` now maintains `{turns: [ts], files: {path: [index]}}`, append-only, so a file can ask which turns wrote it without reading every per-turn record. That is what makes per-line agent attribution affordable ([[concept_line_provenance]]): the trees these refs hold were already the answer, and only the lookup was missing.

## Related

- [[component_chat_panel]] - the source of the exact per-turn file lists.
- [[concept_worktree_backstops]] - the sibling snapshot family, keyed by worktree rather than session.
- [[concept_line_provenance]] - the third consumer of these trees, replaying diffs between them to attribute uncommitted lines.
- [[lesson_checkpoint_refs_keyed_by_timestamp]] — the non-obvious ref-naming decision.
- [[lesson_synthetic_test_values_hide_unit_bugs]] — the backstop's epoch-seconds bug and why the suite could not catch it.
- [[concept_evidence_tiered_attribution]] — the revert guard's two-tier liveness model, shared with the live editing indicator.
- [[component_session_worklog]] — the transcript viewer this builds on.
- [[concept_needs_you_floor]] — a sibling agent-agnostic mechanism built on the same registry foundation.
