---
summary: attached folders resolve into Global from [[attached_folder]], detected from disk without git since git is trust-gated
status: current
updated: 2026-11-03
source: Global space ticket (branch global-space), phase attached-folders; commit 11a1c775; src-tauri/src/attached_folder.rs:243; src-tauri/src/config.rs:865
---

# Attached folders

An attached folder is a project that lives outside the base folder and is used where it is. It exists only in Global. Tori records it as `[[attached_folder]] { path, name }` in `tori.toml`, a fresh table name because old configs may still carry the dropped `[[project]]` and `[discovery].paths` pins.

## How it works

- **Resolve.** `resolve` lists each entry after the root spaces, deduped on the canonical path so a folder also discovered stays in its space. Each becomes an `AttachedProject { project, availability }` in `global.projects`; `availability` is `missing` when the folder is not a directory, with empty branch units. The frontend re-resolves on window focus while Global has projects, so a remounted drive clears itself.
- **Detection without git.** `inspect_folder` reads `.git` (a dir, or a `gitdir:` link), `.bare`, `HEAD`, `packed-refs`, `config` and `worktrees/*/gitdir` from disk to report plain, clone or bare. It never runs git, because `exec::git_in` refuses an untrusted repo and the folder is not trusted until it is attached. `refusal` (`src-tauri/src/attached_folder.rs:243`) rejects home, `/`, the base folder or anything holding it, Tori's own state, an already attached folder or one nested with it, and a linked worktree of another repo.
- **One project-folder source.** `config::project_dirs()` (`src-tauri/src/config.rs:865`) returns root projects plus attached folders on disk, replacing the root-only walks in sessions, trust, review, rpc events, composer, methods and unattended. A bare clone's worktrees can sit anywhere: they are not listed, `rpc::events::project_of` follows a worktree's `.git` link back to its repo (`repo_of_linked_worktree`), and attach trusts them explicitly.
- **Attach** writes the entry under the store lock, then trusts the folder and its outside worktrees and adopts the path (`seed_trust_and_adopt`), since the user picked it in a system dialog.
- **Relocate** (Locate on a missing folder) moves the TOML entry and its `project_meta`, then rewrites keys and string values equal to or under the old path in `attached.json`, `adopted.json`, the issue and unit-origin stores, `trusted.json` and `settings.json`. Sessions recorded at the old path stay there. Rewriting `settings.json` drops hand-written json5 comments.
- **Detach** removes the entry only. The frontend closes the folder's tabs, drops it from every Topic, and deletes a Topic it was the only member of; it never calls `remove_project`.

## Why it is this way

Attached folders are projects in every respect except where they live, so they reuse the project row, branch units and Topic membership; only the source list and the destructive verb differ (Detach, never Remove).

## Related

- [[adr_global_is_a_separate_resolved_field]] - why they sit in `global.projects`
- [[component_project_discovery]] - `resolve` and `probe_project`
- [[adr_sidebar_project_manager]] - the single-root model this extends
