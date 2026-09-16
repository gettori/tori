---
summary: canonicalize fails on a not yet created path, reject parent dir segments first, then canonicalize the deepest ancestor
status: current
updated: 2026-07-10
source: "Shared tab: editable `.shared` folder (personal/sway, branch code-mirror-6); `src-tauri/src/fs.rs` (`ensure_inside`, `resolve_existing_prefix`, `fs_mkdir`/`fs_delete`/`fs_rename`)"
---

# Containment-checking a not-yet-created path

`std::fs::canonicalize` fails on a path that does not exist, which is exactly the create-file / mkdir / rename-destination case, so you cannot canonicalize the target and compare. A fail-closed guard must instead: (1) reject any `..` (`Component::ParentDir`) in the target up front (a lexical `starts_with(root)` check would otherwise pass for `root/../../escape`), then (2) canonicalize the **deepest existing ancestor** and re-append the missing trailing components, and only then compare against the canonicalized root. Resolving the existing prefix (not the lexical path) is what makes a symlink unable to redirect the target out of the root. See `fs.rs::resolve_existing_prefix` + `ensure_inside`, the write-surface for the editable `.shared` tree ([[component_cm6_editor]]). Same canonicalize-both-sides spirit as [[gotcha_git_worktree_list_reports_canonical_paths]].
