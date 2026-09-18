---
summary: grep exclude-dir=worktrees hides every folder of that name anywhere under root, gate the flag on the exact path
status: current
updated: 2026-08-25
source: Features phase 0 (#152), branch `feature-workspace`; `src-tauri/src/search.rs:437`, `src-tauri/src/fs.rs:521`; commit dc20290
---

# grep --exclude-dir matches by basename only

Do not pass `--exclude-dir=worktrees` unconditionally to the plain grep fallback: it hides every folder of that name anywhere under the root, not just `.tori/worktrees`. Gate the flag on `<root>/.tori/worktrees` existing, and in Rust walkers use the parent-child rule `fs::FEATURE_WORKTREES` instead of adding a name to `IGNORED_DIRS` (which would also hide `.tori/settings.json` if you added `.tori`). Why: grep has no path-relative exclude, and `.tori` holds the settings overlay.
