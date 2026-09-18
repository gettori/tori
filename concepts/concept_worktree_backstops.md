---
summary: pre destruction snapshots are owned by a worktree identity minted at creation, so a same named worktree inherits none
status: current
updated: 2026-08-02
source: "Editor wave 2: git depth (personal/tori, branch `wave-2`); Phase 3 (commit e4c3872), wired to discard in Phase 4 (commit b42b494); `src-tauri/src/backstop.rs`, `src/panels/Editor/CheckpointTimeline.tsx`"
---

# Backstops: undo snapshots owned by a worktree identity

Before Tori destroys uncommitted work it takes a **backstop**: a snapshot of the whole working tree that the user can restore from the timeline. Discard is the caller that made this necessary, since it is the one apply path that rewrites files rather than shuffling the index.

## How it works

- **Its own module, deliberately not an extension of [[component_turn_checkpoints]].** Those are keyed by session and exist because a *turn* was reverted. A discard has no session and no prompt boundary, so it has no key of that shape available.
- **The record, not the ref, carries ownership.** The ref (`refs/tori/discard/<worktreeId>/<ts>`) exists only as a gc anchor. A sidecar record under the worktree's **own** git dir (`.bare/worktrees/<name>/tori/`) holds the tree oid, the worktree path, HEAD at snapshot time, and a label.
- Two consequences follow from that and both are the point: listing reads the sidecar and never the refs, so cross-worktree leakage is structurally impossible rather than filtered out; and restore reads `rec.tree` directly, so a re-minted worktree id orphans refs but never orphans a restorable snapshot.
- **The worktree id is minted from creation time plus pid** and stored in the sidecar. Nothing derives it from the worktree's *name*.
- **Snapshotting never touches the user's index**, using the scratch-index + `write-tree` pattern checkpoints already use.
- **The timestamp is monotonic past the newest record**, not merely free of collisions.
- **HEAD is checked asymmetrically.** A whole-tree restore across a moved HEAD refuses outright; a single-file restore refuses by default but takes `force`, mirroring `checkpoint_revert_file`.
- **Restoring consults `revertGuard`**, like every other unscoped worktree rewrite, and reports its touched paths through the `onReverted` channel so open buffers reconcile.
- **Retention prunes beyond a bound**, and `git worktree remove` takes the sidecar with it.

## Why it's this way

**This repo is a bare repo with many worktrees sharing one `.bare`, and worktree names are recycled.** Only `refs/worktree/*` is genuinely per-worktree, so a backstop keyed by name would let a freshly created `wave-2` inherit the undo history of a `wave-2` deleted last week: snapshots of a tree that no longer exists, offered as recovery for work that was never done here. Keying on an identity that dies with the worktree is what makes `a_recreated_worktree_of_the_same_name_inherits_no_backstops` true.

**The monotonic timestamp fixed a real bug the retention test caught, not a hypothetical one.** The stamp started as "bump past any colliding record". But retention prunes the *oldest* ts, so that rule handed the freed low slot to the next backstop, which retention then dropped again as the oldest the instant it was written. The snapshot the user is about to need most was the one silently going away.

**The asymmetric HEAD check is a deliberate deviation** from "restore refuses when HEAD does not match". A symmetric hard refusal would have killed the primary discard recovery path the moment the user committed anything else, which is exactly when they most want a file back.

**Known and accepted:** `backstops.json` is read-modify-write with no lock, so two windows on one worktree discarding simultaneously would lose a record while its ref survives (swept later by `backstop_prune`). Judged not worth a lock file for a user-click-driven action.

## Related

- [[component_turn_checkpoints]] - the sibling ref family, keyed by session rather than worktree, and the timeline both render into.
- [[concept_hunk_level_staging]] - discard is the caller; a backstop is taken only *after* the patch validates, so a refused discard leaves no snapshot behind.
- [[component_changes_panel]] - where discard is offered and where the recovery route is named in the confirm.
