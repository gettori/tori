---
summary: a session's recorded cwd is the grouping anchor, never its branch, letting worktrees and two agents share one tree
status: current
updated: 2026-08-20
source: Worktree-aware tree, multi-agent sessions, and project setup (personal/sway, branch code-mirror-6), commits 5c5177f, 84f2930, 9ca87a9, 3f7efe8, incremental tails and scoped fanout from "Worktree and tab switching at native speed" (branch `unified-tab-bar`, phase 6, commit 267fc4a)
---

# Folder-anchored, multi-agent sessions

How Sway groups, opens, and resumes work. The unifying rule: **a session's recorded `cwd` is the anchor**, not its branch. Branch is a display label, never the grouping key. This is what makes worktrees, branch-switching repos, nested sessions, and two agents (Claude + pi) coexist under one tree. The terminal area groups tabs on the branch-unit `folderPath` derived here — see [[concept_workspace_tab_grouping]] — and hosts each as a shell (see [[concept_shell_hosted_tabs]]).

## The branch-unit abstraction

A project resolves to one or more **branch-units**, each `{label, folderPath, branch?, kind, isCurrent}`, where `kind` is one of:

- **worktree** — a bare container with per-branch worktree folders; one unit per worktree folder, each with its own `folderPath`.
- **plain** — a normal repo; one unit per local branch, all sharing the repo `folderPath`; `isCurrent` marks the checked-out branch.
- **plain-dir** — a non-git folder; a single unit.
- **incomplete** — a `.bare` with zero worktrees (a killed-bootstrap stub); a single cleanable unit.

`folderPath` is the working dir the editor, file tree, gutter, review, fs watcher, LSP, quick-open, and drag all anchor on (`EditorPane.root()` returns `selected.folderPath`). The project container path is kept only for worktree git ops and the display name.

## Session attachment (most-specific)

`list_sessions(folder)` returns Claude + pi sessions whose recorded `cwd` is the folder **or nested under it** (prefix match), newest first. Attachment to the right branch-unit:

- worktree / plain-dir / incomplete units own a distinct folder → they take all of it (a nested-subdir session attaches to its worktree, not the container).
- plain units share one repo folder → Claude sessions split by recorded branch (`s.branch === u.branch`); branchless **pi** sessions park on the `isCurrent` unit.

## Selection, spawn, and safe checkout

`Selection` carries `folderPath`, `projectKind`, `recordedBranch`, `agent`, `sessionFile`, and `sessionCwd`. Resume spawns **per agent at `sessionCwd`** (the session's own cwd, so a nested session resumes where it ran): Claude `claude --resume <id>`, pi `pi --session <sessionFile>`; `+ New` (Claude or pi) spawns at the branch-unit `folderPath`.

**Safe checkout guard** (plain repos only, centralized in `Sidebar.ensureBranch` — the one place that knows the current checkout): opening/resuming a branch that is not the current checkout confirms, runs `git_checkout` (atomic, surfaces stderr), and re-discovers so `isCurrent`/badges refresh; cancel or failure leaves tree + selection intact. Worktrees never checkout. Resume and `+ New` are guarded transitively because selection always precedes them.

## Reading transcripts without re-parsing them

The 1Hz `sessions://changed` heartbeat used to full-parse every transcript
jsonl (43ms for a 19MB file) under a global mutex, which made the fanout a
per-second tax on every switch. Three changes made it incremental:

- **`tail_turns` reads the last 64KB from a line boundary and parses that.**
  Sound because `turn_from_line` (the per-line half of
  `parse_transcript_turns`) yields a turn from a line's own contents alone, so
  the turns the last complete lines produce are exactly the turns a full parse
  would put at the end. The 64KB window is a starting guess, not a limit: a
  tail holding no turn doubles it until one appears or the file is covered.
- **`cached_tail_state` memoises on a `FileStamp`** (mtime + size + a 256-byte
  head sample), so a heartbeat over an unchanged transcript costs a `stat`.
- **`session_prompt_tail` resumes instead of tailing**, because its `count` is
  a total over the whole file. The cache holds the byte offset past the last
  *complete* line already counted; a half-written last line is left for the
  next call. See [[gotcha_size_alone_cannot_tell_an_append_from_a_replacement]].

**The fanout is scoped.** `sessions://changed` carries
`{ folders: string[] | null }`; `folders_for` resolves the burst's touched
paths through the session index to the cwds their sessions are anchored on, and
`refreshSessions(only?)` narrows to those. A run went from 257 `list_sessions`
invokes to 34-58, in bursts of exactly one folder after the initial listing.

**A miss must mean "all", not "omit it".** Only the index knows a transcript's
cwd (encoding a cwd into a directory name belongs to the agent), so a file Sway
has not parsed yet cannot be attributed, and that file is precisely the
brand-new session whose whole point is to make an unlisted folder appear. One
unresolved path therefore makes the whole payload `None`.

## Connections

- Realized by [[component_project_discovery]] (the payload) and [[component_session_scanner]] (the sessions).
- Implements [[concept_filesystem_source_of_truth]] — branch-units and sessions are both derived from on-disk git + jsonl.
- Feeds [[component_pty_host]] — a selected session becomes a resumed terminal at its `sessionCwd`.

## Related

- [[gotcha_mtime_cache_must_key_on_dir_mtime_and_head]] — why `isCurrent` refreshes after a checkout.
- [[gotcha_gitbranch_is_recorded_at_session_creation]] — why a plain-repo session can mismatch the checkout (the badge).
- [[gotcha_size_alone_cannot_tell_an_append_from_a_replacement]] - the resume-by-offset trap.
- [[concept_release_profile_tracing]] - how the fanout cost was measured.
