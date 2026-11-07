---
summary: move_into_space renames from a journal, relinks worktrees as files without git, then rekeys every path store
status: current
updated: 2026-11-07
source: "fit any base folder plan (branch move-any-folder-or-project-to-space); src-tauri/src/space_move.rs; src/utils/moveProjects.ts; src/utils/moveIntoSpace.ts; commits f278e821, 48f942eb"
---

# Space move

Moving a project folder into `<base>/<space>/<name>` is one backend command, `move_into_space`, used by setup grouping, Sort into spaces, Move here and Move to space. It moves the folder for good: nothing is left at the old path.

## How it works

- **Plan, then journal.** `plan` turns each `MoveRequest { space, name, path }` into a `Planned { from, to, real, done }` after `refusal` passes, and refuses two requests landing on one target. The batch is saved to `<config_dir>/move-journal.json` before anything moves, and each move flips `done` and resaves. `real` is the canonical source, kept because links git wrote may use either spelling and it cannot be worked out once the folder is gone.
- **Relocate.** `relocate` renames only while the source still exists, then `relink_worktrees` rewrites each `worktrees/*/gitdir` backlink and the checkout's `.git` line as files. Only absolute links are touched. No git runs, since a folder from outside the base is not trusted.
- **Settle.** Every step after the rename reports instead of stopping: sessions (adopted), issues, issue repos, unit origins, trust, settings, attached branches and the config entry (`config::settle_moved_entry`, which drops an attached entry) are rekeyed, then `topics::move_repo`. The frontend follows with `moveWorkspaces` ([[concept_workspace_move]]).
- **Resume.** A journal left by a crash blocks every new move ("An earlier move didn't finish. Resume it first.") and the sidebar shows a Resume banner calling `resume_moves`. Rerunning a half-done move is safe: the rename is skipped once the source is gone and relinking finds nothing under the old path.
- **Refusals** (`refusal`, also behind `move_check` for the dialogs, minus the live-session check): not a folder, no space folder, moving into itself, Tori's own state, a space folder, a name already taken in any case, a worktree of another repo, a conversion journal present, another volume, and a live session under the path.

## Why it is this way

- Live sessions come from the daemon's `pty.list` plus the chat host, not the window's tabs, because a move removes the old path and a detached session would lose its cwd.
- Cross-volume moves are refused with Home attach suggested: copy then delete is too risky for a repo with unpushed work.
- No symlink at the old path, and agent session history stays keyed there, as with conversion. The dialogs say so.
- `run_journal` takes the per-move step as a closure so tests never touch the real stores.

## Related

- [[concept_workspace_move]] the frontend half
- [[concept_base_folder_fit]] the grouping that batches moves
- [[adr_moving_trusts_only_with_convert]] why a move never trusts, except with Convert
- [[concept_attached_folders]] a Home project moved into a space stops being attached
- [[concept_worktree_layout_conversion]] the optional convert after Move here
