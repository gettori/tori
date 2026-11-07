---
summary: a top-level git repo is not a space; scan_root walks a candidate base with a budget, and grouping applies in a fixed order
status: current
updated: 2026-11-07
source: "fit any base folder plan (branch move-any-folder-or-project-to-space); src-tauri/src/base_layout.rs; src-tauri/src/root_scan.rs; src/utils/grouping.ts; commits 0084dd55, 0b768e86, f69eceaf"
---

# Base folder fit

Tori reads the base as `<base>/<space>/<project>`, but many people dump every repo in one folder. Discovery now refuses to read a project as a space, and setup scans a candidate base and lets the user group loose projects into spaces.

## How it works

- **Rules** (`base_layout::Rules { ignore, not_spaces, attached }`). A top-level folder is a space unless it is skipped, listed in `[discovery].not_spaces`, attached, or `top_level_project`: a `.bare`, or a `.git` that holds no independent repo of its own. A manifest alone never demotes a top-level folder. Inside a space, a non-project folder holding git repos is a container, not a project, and its repos are `misplaced`.
- **Misplaced.** `ResolvedConfig.misplaced` lists top-level projects and repos one level inside a container, never a worktree of another repo, for the sidebar banner. `setup_would_group` is the wider setup rule, which also takes a manifest-only folder with no repo inside.
- **Scan** (`root_scan::scan_root`). Never runs git. Skips `node_modules`, `target`, `vendor`, `.venv`, `dist`, `build` and dotfolders, never enters a project, never follows a symlink, stops at depth 4 (`too_deep`), and reads at most 2000 folders per top-level folder (`too_big`). Refuses home or `/`, Tori's own state, a base that is itself a project, an unreadable folder, and a base where every walked folder is too big. A loose project's suggested space is the owner in its origin URL (`remote_owner`).
- **Apply** (`grouping::applyPlan`): `set_root` (setup only), `add_space` for new or hidden targets (which unhides), one `move_into_space` batch, `attach_folder` for rows left on Home, then `hide_spaces` from `hiddenAfter`. Collisions, case-insensitive, against other rows and against `RootScan.folders` entries, disable Apply first.

## Why it is this way

- `not_spaces` is its own key scoped to the base top level; `[discovery].ignore` matches names at every level.
- A folder the scan did not finish (too big, unreadable) is never hidden, since it may hold projects the scan never saw.
- Bounded scan over deny-only: a one-time job, and deny-only fails the dump-folder users this is for.

## Related

- [[component_project_discovery]] where the rules apply on every resolve
- [[concept_space_move]] the batch Apply runs
- [[concept_attached_folders]] where ungrouped projects go
