---
summary: asking git for a renamed file's diff by new path alone loses rename detection and renders it as a whole new file
status: current
updated: 2026-08-02
source: "Editor wave 2: git depth (personal/sway, branch `wave-2`); Phase 7; `src-tauri/src/git.rs` (`git_commit_file_diff`), `src/panels/Editor/CommitDetail.tsx`; commit b108974"
---

# Pathspec-limited rename detection needs both paths or it is not a rename

Don't ask git for a renamed file's diff by its new path alone. Why: rename detection pairs the two sides only when **both** are inside the pathspec, so `git diff-tree -M <sha> -- newpath` comes back as a whole-file addition with `new file mode` instead of `rename from`. The whole file then renders as green, which looks like a plausible commit rather than a bug. Carry `old_path` on the file record all the way to whatever issues the diff, and pin it with a test that asserts *both* readings, with the pair and without.
