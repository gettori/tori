---
summary: every save becomes one git blob ref'd by worktree and hashed path, since a repo relative path is not a legal ref name
status: current
updated: 2026-08-05
source: "Editor Wave 6: the IDE surface (personal/sway, branch `wave-6`); Phase 15, issue #51, commit b622f33; `src-tauri/src/local_history.rs`, `src/panels/Editor/LocalHistory.tsx`"
---

# Local history: one blob per save, ref'd by worktree and hashed path

Every save the editor makes is recorded as a git blob, ref'd at `refs/sway/localhistory/<worktreeKey>/<pathHash>/<ts>`. It answers the question `git log` never can: not what was committed, but what was *had* - the edit made, saved and replaced ten minutes later without ever being staged. Restoring writes those bytes back to the file and touches nothing else, so whatever was staged survives it.

## How it works

- **`local_history_note`** (`local_history.rs:190`) runs `git hash-object -w --no-filters` on the saved file, compares the sha against the newest existing entry, and either dedups or writes one ref. One object write, no index, no tree. `enforce_caps` then trims to `MAX_PER_FILE = 50` and `MAX_AGE_MS = 14 days`, deleting through a single batched `git update-ref --stdin`.
- **`digest`** (`:71`) is FNV-1a written out by hand. It hashes both the worktree toplevel and the repo-relative path.
- **`worktree_key`** (`:85`) is the digest of `rev-parse --show-toplevel`. A bare repo's worktrees share one ref store (`agent_lines.rs:27`), so without it two worktrees editing the same relative path would interleave one timeline.
- **`local_history_prune`** (`:441`) sweeps two ways: entries older than the age cap, and every worktree key not among the live ones. Live keys come from `worktree list`, hashed the same way, which is the whole reason the key is a recomputable digest rather than an opaque id.
- **Renames and trashes carry or collect the history**, including for directories: `files_under` (`:292`) walks recursively, skipping symlinks. A folder rename reads off the **destination** (the files are already moved, so each old path is the new one with the prefix swapped back). A folder trash reads off the **source**, which is why `local_history_forget` must run *before* `fs_delete`.
- **`local_history_diff`** (`:251`) hashes the working file so both sides of the diff are blobs. The object is unreferenced and gc'd, and in the usual case (nothing edited since the last save) it is already the newest entry, so nothing new is written.

## Why it's this way

**Blobs, not trees.** The checkpoint family ([[component_turn_checkpoints]]) snapshots the whole worktree with `git add -A` + `write-tree`, which is right for a prompt boundary. A save is far more frequent and concerns exactly one file, so it needs `hash-object` cost rather than `add -A` cost, and dedup by blob sha rather than by tree identity.

**The path is hashed because a repo-relative path is not a legal ref path.** A leading-dot component, a `.lock` suffix and a `..` sequence are all ordinary filenames and all rejected by `git update-ref`. The cost is that a ref name says nothing on its own and no "which files have history" listing can be derived from the ref store, which is acceptable while every entry is reachable from the file it belongs to.

**The digest is spelled out rather than `DefaultHasher`** because it names a ref that must still resolve after a toolchain upgrade. See [[lesson_a_persisted_key_must_not_depend_on_an_unspecified_hash]].

**`--no-filters` is deliberate.** This records the bytes that are on disk so a restore puts those bytes back; running the repo's clean filter would store what git *would commit*, which is a different file. For the same reason the read path uses `git_output` and not `git_capture` - see the gotcha below, which was a content-corrupting bug four tests caught at once.

**An empty `worktree list` is treated as "git could not answer", not "no worktrees".** Collecting on that answer would delete every timeline in the repo.

**It is a sibling of the git file-history tab, not a replacement.** Both hang off the same tab context menu and the same synthetic-tab machinery; the version somebody is hunting for is usually in the half the other never kept.

## Related

- [[component_turn_checkpoints]] — the whole-tree snapshot family this deliberately does not copy.
- [[concept_path_keyed_workspace_stores]] — the frontend siblings that follow the same rename and trash.
- [[concept_synthetic_editor_tabs]] — `sway://localhistory/<path>?ws=` is one of the two kinds this wave added.
- [[lesson_a_persisted_key_must_not_depend_on_an_unspecified_hash]] — why FNV-1a is written out.
- [[gotcha_git_capture_trims_and_git_output_does_not]] — the trap on the read path.
- [[gotcha_a_repo_relative_path_is_not_a_legal_ref_path]] — why the path is hashed at all.
