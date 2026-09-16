---
summary: a git rename or copy record spends three fields where every other change spends two, desyncing a fixed size chunker
status: current
updated: 2026-08-02
source: "Editor wave 2: git depth (personal/sway, branch `wave-2`); Phases 2, 5, 7; `src-tauri/src/git.rs` (`parse_status`, `git_stash_show`), `src-tauri/src/git.rs` (`git_commit_files`); commits db98306, 3071c3a, b108974"
---

# A rename or copy record spends an extra field, so a fixed-size chunker desyncs

Don't chunk git's NUL-separated output into fixed-size records when rename detection can be on. Why: a rename or copy spends **three** fields where every other change spends two (`R100`, old, new), so a `chunks_exact(2)` desyncs from the first rename onward and hands a status code to something expecting a path. This bit three times in one ticket, in three different commands: `status --porcelain=v2 -z` (type `2` carries the original as the *next* record), `stash show --name-status -z`, and `diff-tree --name-status -z`. Pull `fields.next()` explicitly and branch on the status letter, or pass `--no-renames` where the pairing genuinely does not matter (a stash apply really does create one path and remove the other). Note that type `2` covers renames **and** copies, so the pairing must not key on the `R` score.
