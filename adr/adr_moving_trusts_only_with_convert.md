---
summary: moving a folder never grants git trust, except ticking Convert in Move here, which trusts before the preview and revokes on refusal
status: current
updated: 2026-11-07
source: "fit any base folder plan (branch move-any-folder-or-project-to-space), phase sidebar-move-into-space; src/utils/moveIntoSpace.ts; commit 48f942eb"
---

# Moving trusts only with Convert

## Decision

A move, from grouping, Move here or Move to space, never trusts a folder. The one exception is the **Convert to worktree layout** box in the move dialogs: ticking it is consent to trust, the same consent Home attach takes from a folder picked in the system dialog.

`conversion_preview` needs git, and `exec::git_in` refuses an untrusted repo. So `moveIntoSpace` trusts the source when the store (read fresh, `trustedNow`) does not cover it, runs the preview, and on a refusal revokes that grant, unticks the box and moves nothing. Otherwise it moves (settle rekeys the trust), trusts the new path and converts with `withDefault`. The dialog only previews early for a clone that is already trusted.

## Alternatives rejected

- **Trust on grouping.** Ticking a row is not consent to run a repo's hooks or fsmonitor.
- **Preview past the gate.** A trust-free git path for the preview would be a second way around the trust model.
- **Preview after the move.** A refusal would then leave the folder moved when the user asked for a converted one.

## Consequences

A refused preview briefly trusts the source. If the revoke fails, the refusal text says it stays trusted.

## Related

- [[concept_space_move]]
- [[concept_attached_folders]] the attach precedent
- [[gotcha_project_trusted_is_false_until_the_trusted_list_loads]]
