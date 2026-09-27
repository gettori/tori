---
summary: Changes panel is a consumer of shared git state, not its owner, so staging from the palette and the panel is one signal
status: current
updated: 2026-09-27
source: "Review-to-prompt + commit flow (personal/tori, branch `topbar`); commits ad53d40, 315b15b, f8fd1a3, 35bc401; extended by Editor upgrades: diff polish, hunk staging, diagnostics (phases 1-2); commits d1a6844, 01f0196; selective refetch from \"Fix the stale `fs://changed` payload contract in ReviewPanel\" (branch `wave-1-3`, issue #12); git state and actions lifted into a shared store by Editor wave 1: close out the fundamentals (branch `wave-1-4`), Phase 3, issue #15, commit bd9567c, grouped by member for Features by phase 5: unified changes and the git slot map (#157, branch `feature-workspace`), phases 2 and 3, commits 41b8ab3, 9687380; plan "Show merged and closed PR status on worktree rows" (personal/tori, branch `misc-20260927`), commits 6cfe26b5, 2d139c7e, 4d8a5c5d, `src/panels/Editor/ReviewPanel.tsx:475`"
---

# Changes panel

**Location:** `src/panels/Editor/ReviewPanel.tsx`, `src/panels/Editor/ReviewPanel.module.css`, `src/utils/diffView.ts`, `src/utils/prUrl.ts`, `src-tauri/src/git.rs`, `src-tauri/src/patch.rs`

The Changes panel (`ReviewPanel.tsx`, the Editor pane's "Changes" right-panel mode — see [[component_cm6_editor]]) grew from a read-only `git_status` list into a VS Code-style stage/commit/push/PR surface, all through native `git` shelled from Rust, with no left-sidebar git controls (that stays [[component_project_discovery]]'s territory for branch-level ops).

## It no longer owns the git state (2026-08-02)

The file list, branch and ahead/behind moved into [[component_editor_stores]]
(`src/utils/gitActions.ts`), and so did `stage`/`unstage`/`commit`/`push` with
its `waitForPush` listener pair. The panel is now a **consumer**: it reads
`stagedFiles()` / `changedFiles()` / `gitState().branch` / `gitState().aheadBehind`
and calls the shared actions.

Why: this panel is unmounted whenever the right pane shows anything else, and the
command palette's git entries have to answer "is anything staged?" with it
closed. The payoff is symmetric - staging from ⌘K moves the panel with no other
interaction, and staging in the panel updates what ⌘K offers, because there is
one signal rather than two copies. `ReviewPanel.test.tsx` pins exactly that: a
`stage()` call from outside moves the row into the Staged section.

Still local, because only a mounted panel has any use for it: the expanded diff
and its gap expansions, the side-by-side preference, and the PR `origin` /
default-base-branch pair. Its agent-writes and window-focus refreshes also stay
here. (**2026-08-27:** the `fs://changed` file-list refresh moved out to
`startGitWatch`, see the section below.)

## One section per member inside a Feature (2026-08-27, #157)

A Feature is several repos opened as one workspace ([[concept_feature_workspace]]), and this panel was a single-root consumer top to bottom. It now takes `roots?: MemberRoot[]` from `Editor.tsx`'s existing `treeRoots()` and derives `sections()`: one unnamed section carrying `props.root` for a branch unit, so that path renders exactly the DOM it always did, and one per member in member order for a Feature.

- **Each section reads its own slot** through `gitStateFor(section.root)` ([[concept_per_member_git_slots]]) and draws its own Conflicts / Staged / Changes. Every action that used to close over `props.root` now takes the section's: `row`, `conflictRow`, `toggleDiff`, `fileDiff`, `applyHunk`, `applyLines`, `discardHunk`, `discardFile`, `copyDiff`, `openFile`.
- **A member header carries the tinted chip, label, branch, ahead/behind and a Stage all / Commit / Push trio** acting on that root, with Push reading `pushingIn(section.root)`. A member whose `state` is not usable renders its header with the state and a repair button instead of a file list, the same shape `FileTree`'s section list uses and for the same reason: the header is the only place that member's state gets said.
- **A clean member keeps its header.** The panel-wide "No changes yet" note would otherwise take away the branch, ahead/behind and Push of every member at once, so a clean member gets a "No changes" line under its own header. A branch unit still shows the note exactly as before.
- **The top bar loses branch, ahead/behind and Push inside a Feature.** Those are one repo's answers and a Feature has several. The side-by-side toggle stays, and Open PR plus the stash list stay one-repo on the active root, matching #151's right-panel table.
- **`expanded` is keyed by `root + path + staged`.** A frontend/backend Feature holds `src/index.ts` twice, so a key of path alone lets two members share an expanded row and show each other's diff. One row is open panel-wide, as before.
- **The reset effect keys on the joined section roots**, not on `props.root`. Moving between members inside a Feature is not a workspace switch, so collapsing the open diff and re-reading everything would be reacting to something that did not happen. See [[lesson_a_reset_key_must_name_what_changed]].
- **The `fs://changed` listener kept the stash read and the expanded-diff refetch and lost the file-list refresh** to `startGitWatch`, so status stays true with the panel closed. Both survivors are matched against the payload's root.
- **`refreshAll` (window focus, post-revert) covers every section's slot**, not just the active root. `.git` is watcher-filtered, so a commit made in a background member from a terminal tab has no other way in.
- `ReviewPanel.stories.tsx` is the workshop record: three members, one mid-conflict, one clean, one `worktree-missing`, plus the headerless single-root case.

## One member at a time, named on screen (2026-08-27, #157 phase 3)

There is one commit box, not one per member: a box per section multiplies subject, body, amend and pre-amend draft state by member count for a workflow that is one repo at a time anyway. So the box needs a target, and the target needs saying.

- **`targetMember()` is an explicit pin, else the member owning the active editor tab (`rootOf`), else the member in front.** A section's Commit pins it and focuses the box; opening a file in another member does **not** move a pin, because the line above the box is the only thing on screen saying where the message lands and having it move under the reader is worse than having to click again.
- **The box says which member it is committing in**, chip and all, so a retarget is visible rather than silent. `commit`, `toggleAmend` and `canCommit` read that member's slot.
- **The section header's Commit and the box's Commit are two controls a word apart** and only one of them commits, so the header's carries `aria-label="Commit in <member>"`. The tests found that collision before a reader would have.
- **`CheckpointTimeline` gets the target member for both `root` and `folderPath`**, so its refs, its chat list and its turn joins all name one repo.
- **"Ask agent to draft" names the target's staged paths the way the session's own cwd resolves them.** It does *not* rewrite the target's `folderPath` / `sessionCwd`: see [[gotcha_retargeting_a_drafted_message_by_rewriting_sessioncwd_misdirects_every_relative_path]].
- **The palette's git commands resolve the member from the active file** (`Editor.tsx:1834,1844`), so staging a file that lives in a background member stages it there rather than refusing with "isn't in this workspace" about a file that plainly is.

## Responsibilities

- **Staged/Changes split.** `git_status` (`git.rs`) returns `staged`/`unstaged` booleans per file. (**2026-08-02:** these are now derived per porcelain **v2 record type** rather than from an XY column scan, and a third flag `conflicted` joined them; see [[concept_porcelain_v2_status]]. The paragraph below describes the v1 reading it replaced.) Derived from the porcelain XY code (X = index column, Y = worktree column; untracked `??` counts as unstaged only) — no extra git invocation, just two booleans computed alongside the existing status string. A partially-staged file (`MM`) gets a row in **both** sections; each row's diff-expand state is keyed by `${section}:${path}`, not path alone, so the two rows toggle independently.
- **Stage/unstage/commit** (`git_stage`, `git_unstage`, `git_commit` in `git.rs`) are local, synchronous, no askpass — `git add --`, `git restore --staged --`, `git commit -m`. Every path-taking command passes `--` before paths (a `-`-prefixed filename must not be parsed as a flag). `git_unstage` deliberately uses `restore --staged`, not `reset HEAD`, since the latter fails on an unborn HEAD.
- **"Ask agent to draft"** routes a request naming the currently staged files through [[concept_safe_send]], sharing its capability gate (`disabledReason`: no session selected, or the adapter can't resume) and insert-only behavior with the hunk-comment affordance.
- **Push** (`git_push`, a sibling of `git_fetch`) runs on its own thread through the same askpass bridge ([[concept_askpass_bridge]]), deciding `--set-upstream` via a pure `has_upstream(repo, branch)` helper (`rev-parse --abbrev-ref --symbolic-full-name <branch>@{u}`) so that decision is unit-testable without constructing an `AppHandle`/`AskpassState`. Emits `git://push-done`/`git://push-error`.
- **Ahead/behind indicator** (`git_ahead_behind`) reuses `has_upstream` to gate an "unpushed branch" state, else `git rev-list --left-right --count <branch>...<branch>@{u}`. The indicator doubles as the push button.
- **"Open PR"** derives the compare/MR/PR URL from `git_origin` via the pure `src/utils/prUrl.ts` (`parseOrigin`/`comparePrUrl` — GitHub, GitLab, Bitbucket; https, ssh://, and scp-like `git@host:owner/repo`; builds the URL off the *parsed host* so a self-hosted instance gets its own domain, not a hardcoded public one) and a base branch from `git_default_base_branch` (`origin/HEAD` symref, else a probe for `origin/main` then `origin/master`). Pushes first only when needed (`!has_upstream || ahead > 0`), reusing the push path; hidden unless both an origin and a resolvable base branch exist.
- **"Reopen PR"** replaces Open PR when the branch's PR closed unmerged (`ReviewPanel.tsx:475`). A deleted branch is pushed back first only when its tip is the PR's head and the head is not a fork; commits past the closed PR get Open PR instead. Open PR is hidden for a merged branch with nothing made since. See [[concept_a_finished_pull_request_is_kept_by_relation]].
- **Freshness.** `.git` is watcher-filtered out of `fs://changed` ([[gotcha_the_project_watcher_must_filter_churn_dirs]]), so a terminal-side `git commit`/`push` emits no filesystem event. The panel instead refreshes on `fs://changed`, window focus, and `git://fetch-done|error` / `git://push-done|error` — all folded into one `refreshAll()` called from every trigger point.
- **Diff mode is explicit and three-valued** (`DiffMode` in `git.rs`): `head` (worktree-vs-HEAD, the default), `staged` (index-vs-HEAD), `unstaged` (worktree-vs-index). A partially-staged file's two rows genuinely compare different trees, and one flag cannot describe both. The default stays vs-HEAD because the gutter and session diff depend on it — staging a file must not blank its gutter marks.
- **A real review surface** (`src/utils/diffView.ts`, pure and unit-tested; the panel only renders):
  - **Word-level intra-line highlights.** Lines pair only within an equal-length -/+ run, or by best similarity above 0.3; anything unpaired renders plain. Highlighting every token of an unpaired line buries the actual edit. Perf caps are load-bearing: no word diff past 2000 chars, no similarity pairing past 40-line runs.
  - **Between-hunk gaps.** `hunkGaps` computes the untouched ranges the diff omits; expanding one reads it back through `git_file_slice`, which is **mode-aware** (staged mode reads the *index*, not the worktree). See [[lesson_diff_context_is_hunk_granularity]] for why the context is not simply widened instead.
  - **Side-by-side toggle**, persisted in localStorage, forced back to inline below a width threshold. Both columns share one scroll container, so they stay aligned by construction rather than via a sync handler. The hunk header is the shared control anchor, so per-hunk actions sit in the same place in both modes.
  - **Per-file copy diff**, through the `writeText`-rejection fallback in `src/utils/clipboard.ts`.
- **Hunk-level staging.** Per-hunk stage/unstage in the hunk header, both sections, both view modes, via `git_apply_hunks` — see [[concept_hunk_level_staging]] for the patch-rebuild, direction, and fingerprint mechanism. The panel sends the fingerprint it rendered; an apply failure refetches the diff *before* surfacing the error, and an `fs://changed` naming the open file refetches too, so the user never retries against stale hunks.
- **The expanded-diff refetch is scoped to the open file, and has to be.** `refreshExpandedDiff` does not only re-read the diff, it also clears `openGaps`/`gapLines`, so a refetch discards every between-hunk gap the user expanded. Refetching on an unrelated file's change therefore *destroys work in progress*, which is why the `fs://changed` guard must genuinely test the payload rather than fire unconditionally (it did the latter for a while, see [[gotcha_an_as_cast_on_an_event_payload_opts_out_of_the_contract]]). The predicate is a **suffix test**, `paths.some(p => p.endsWith(open.path))`, shared verbatim with the `AGENT_FILES_WRITTEN` handler so the two routes cannot disagree. Suffix rather than a path comparison because `open.path` is porcelain's field, not reliably a path: `parse_status` takes `line[3..]` whole, so a rename arrives as the literal `old.ts -> new.ts` and a non-ASCII name arrives quoted and escaped. Those two shapes already render an empty diff (the same string goes to `git_diff_text` as a pathspec that matches nothing), a pre-existing gap this scoping neither fixes nor worsens. The `refresh()` of the file *list* stays unconditional on every burst.
- **Does NOT**: provider OAuth/API PR creation (the compare page is opened in the browser, not created via API), force-push in any form, or line-level *discard* (line selection stages, the discard control stays whole-hunk).

## It became the repo's git surface (2026-08-02, Editor wave 2)

Six sections' worth of git landed here at once. What each one is and why is written up where the mechanism lives; this is the map.

- **Conflicts, at the top.** A `u` record is now `conflicted` and exclusive with staged/unstaged ([[concept_porcelain_v2_status]]), so a conflicted file appears here and nowhere else. Its row opens the three-way view rather than the marker-riddled file, and carries its own "Ask agent" ([[concept_three_way_conflict_model]]). The row is a `<button>`, not a `<div onClick>`: opening the view is its only action, and a div made the whole section mouse-only.
- **Discard**, per hunk and per file, the panel's only destructive action. A hunk discard is scoped to what the user is looking at and does **not** consult `revertGuard`; a whole-file discard is worktree-wide and does. Both take a [[concept_worktree_backstops]] snapshot first, and the confirm names the blast radius and the recovery route.
- **Line-level staging.** Clicking a changed line in the expanded diff picks it, and the hunk header then offers to stage or unstage just what is picked, in either section. Selection is one hunk at a time, cleared whenever the diff moves, and keyboard-reachable. See [[concept_hunk_level_staging]] for the patch rebuild and the ordering consequence it inherits.
- **Stash**, listed with per-entry apply / pop / drop and an include-untracked checkbox defaulting **off** to match git. Every stash mutation is worktree-wide so all of them consult `revertGuard`. Drop is the one action with no way back and the dialog says so: a backstop snapshots the working tree, and a stash is not in the working tree, so no backstop could contain it.
- **Commit gained a body and an amend.** Subject and body join per git convention (`src/utils/commitMessage.ts`, pure and unit-tested), amend prefills from `git log -1 --format=%B`, and amending a pushed HEAD **warns rather than blocks**, because the check reads a remote-tracking ref that is only as fresh as the last fetch.
- **The commit log opens from the header** as a [[concept_synthetic_editor_tabs]] tab, in the editor pane where there is width to read it ([[component_commit_history]]).

Two pieces of shared plumbing came out of it. `guarded(verb, action)` holds the revert-guard block that was about to get its fourth copy, and `busy(action)` holds the applying flag **across confirms**: the confirm dialog is a singleton bound to one signal, so a second click while one is open silently replaces the pending question and you answer about one file believing you answered about another. That bug was found separately in three phases before it became structural.

## Key files & entry points

- `src-tauri/src/git.rs` — `git_status`/`parse_status` (staged/unstaged split), `git_stage`/`git_unstage`/`git_commit`, `git_push`/`has_upstream`, `git_ahead_behind`, `git_default_base_branch`.
- `src/panels/Editor/ReviewPanel.tsx` — `:250` `sections`, `:259` `headed`, `:275` `commitTarget` and `:276` `targetMember`, `:360` `commitIn`, `:437` `askAgentToDraft` (`:448` the `mentionPath` composition), `:1110` the row key; plus `refreshHeader` / `refreshAll` and the diff/hunk surface. The actions and `pushBranch`/`waitForPush` live in `src/utils/gitActions.ts`.
- `src/panels/Editor/ReviewPanel.stories.tsx` — the three-member, missing-member and single-root stories; `loadRoots` is the `enterRoots` + `refreshGit` pair a story needs before the panel will paint.
- `src/utils/prUrl.ts` — `parseOrigin`, `comparePrUrl`.
- Tests: `ReviewPanel.test.tsx` (66), including `describe("inside a Feature")` and `describe("the member a Feature commits in")`.

## Connections

- Depends on [[concept_safe_send]] — hunk comments, selection mentions, and "ask agent to draft" all route through `requestSend`.
- Depends on [[concept_hunk_level_staging]] — the patch-rebuild + fingerprint mechanism behind its per-hunk, per-line and discard controls.
- Depends on [[concept_porcelain_v2_status]] - the status parse its three sections are derived from.
- Depends on [[concept_worktree_backstops]] - the snapshot every discard takes, and the recovery route its confirms name.
- Depends on [[concept_three_way_conflict_model]] - what the Conflicts section's rows open, and the ask they offer.
- Depends on [[concept_per_member_git_slots]] - the slot each section reads, and the strict membership that means a story has to enter its roots before it paints.
- One instance of [[concept_member_fan_out]], with a store rather than a merge: the fan-out shape it shares, and the two places it needed more, are on that page.
- Opens [[component_commit_history]] from its header, as a [[concept_synthetic_editor_tabs]] tab.
- Constrained by [[lesson_diff_context_is_hunk_granularity]] — why `DIFF_CONTEXT` is git's default and gaps are read back separately.
- Depends on [[concept_askpass_bridge]] — `git_push` is a sibling of `git_fetch` through the same bridge.
- Hosted by [[component_cm6_editor]] as the "Changes" right-panel mode.
- Failures (stage/unstage/commit/push) surface via the same global `TOAST` event `HunkCommentInput` already used — no new notifier.

## Related

- [[component_member_chip]] - the shared chip its two member section headers moved onto in #158, replacing local chip CSS

- [[gotcha_rev_parse_abbrev_ref_head_returns_head_on_an_unborn_branch]] — `git_ahead_behind` relies on this same quirk: an unborn/detached HEAD reports literal `"HEAD"` rather than erroring, which then just fails `has_upstream` and falls into the "unpushed" state.
- [[gotcha_origin_head_symref_is_usually_unset_after_a_manual_remote_add]] — why the `origin/main`/`origin/master` probe, not the symref, is the path that actually fires for PR base-branch derivation in this app.
- [[concept_fs_change_pipeline]] — the watcher this panel's freshness rides on, and the `FsChanged` payload contract its refetch guard reads.
- [[gotcha_a_keyed_listener_map_in_a_test_shadows_a_second_listener_for_the_same_event]] — the panel renders `CheckpointTimeline`, which subscribes to the same event, so any test driving `fs://changed` here must fire every registered handler.
- [[concept_a_finished_pull_request_is_kept_by_relation]] - Open PR and Reopen PR for a finished pull request
