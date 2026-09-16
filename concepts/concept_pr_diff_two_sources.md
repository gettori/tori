---
summary: a PR diff mixes GitHub's own patch for changed hunks with a local fetch of the head ref for the unchanged gap content
status: current
updated: 2026-08-03
source: "Editor Wave 3: GitHub as a first-class surface (personal/sway, branch `wave-3`); Phase 9; commit ce1c941; `src-tauri/src/git.rs:250`, `src/utils/prFiles.ts`, `src-tauri/src/forge/github.rs:46`"
---

# A pull request diff has two sources

Rendering a pull request's changes needs two different kinds of content, and the split between them is the whole design. The changed hunks come from GitHub, which already computed them. The unchanged lines around a hunk (what the reader expands into) come from **the local git object store**, fetched once with `git fetch origin refs/pull/{n}/head`. Neither source can do the other's job.

## How it works

- **Changed hunks: GitHub's own patch.** `pulls/{n}/files` returns each file with its patch already built, so nothing recomputes a diff Sway did not produce.
- **Gap content: a local fetch of the PR head.** `refs/pull/{n}/head` is a ref the forge publishes, so `git fetch --no-tags origin refs/pull/{number}` (`git.rs:250`) puts the exact head commit in the local object store, and expanding a gap is then a blob read at **zero API quota**. `diffView.ts` would otherwise read unchanged regions back from the working file, which is the wrong content for a head that was never checked out.
- **The fetch is lazy and conditional.** A head already in the object store is never fetched again (`git.rs:2978` asserts it), and nothing is fetched until a reader actually expands a gap.
- **It must go through the askpass bridge.** The fetch is a network git operation, so it is built with `git_command(repo, op_id, sock, token)` like every other one. Phase 9 shipped it bypassing that and self-review caught it. See [[concept_askpass_bridge]].
- **GitHub stops at 300 files** (`PR_FILE_CAP`, `github.rs:46`). That ceiling is the server's, not a budget Sway chose, so a larger pull request says how many files were not listed rather than showing 300 and looking complete.
- **Not every file has a diff to show.** `fileSkip` (`prFiles.ts:25`) separates too-large, moved-without-content and binary, so each gets its own sentence instead of an empty pane.

## Why it's this way

Sway already shells out to git for everything else ([[concept_filesystem_source_of_truth]]), so the local object store was available and free, while every alternative for gap content costs API requests per expansion, which is exactly the spend [[concept_forge_rate_budget]] exists to avoid. The 300-file ceiling and the skip reasons are both instances of the same rule this vault keeps rediscovering: when a source truncates or refuses, say so, because a silently short list reads as a complete one.

## Related

- [[concept_review_line_anchoring]] - what a reader does with these rows
- [[concept_askpass_bridge]] - why the fetch cannot be a bare `git` invocation
- [[concept_forge_rate_budget]] - the quota this design spends nothing of
- [[component_pull_requests_panel]] - the detail view rendering both sources
- [[gotcha_pulls_n_files_stops_at_300_files]]
- [[gotcha_every_network_git_op_must_be_built_with_git_command]]
