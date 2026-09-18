---
summary: the whole session tree is derived from claude jsonl, git and tori toml on disk, never a private Claude API
status: current
updated: 2026-06-28
source: Tori build plan (personal/tori); `src-tauri/src/sessions.rs`, `src-tauri/src/config.rs`; commits 3c2cde1, e121aeb
---

# Filesystem as source of truth

Tori never calls a private Claude API. Everything it shows, the whole Space → Project → Branch → Session tree, plus session titles, last-activity, and live status, is **derived from on-disk state**: Claude's own session transcripts under `~/.claude/projects/`, the git repo at each project path, and the user's `tori.toml`. This is the load-bearing design choice: it is stable across Claude Code updates because the on-disk JSONL layout is the de-facto contract, and it needs no cooperation from the Claude binary beyond running it.

## How it works

Three on-disk inputs combine:

- **Structure** comes from `~/.config/tori/tori.toml`: each `[[project]]` declares a `space` (legacy key `group` still accepted), `name`, and one working-dir `path`. See `src-tauri/src/config.rs` (`get_config`).
- **Branches** come from live git at each project path (`git branch --format=%(refname:short)\t%(HEAD)`), see `config.rs` (`list_branches`).
- **Sessions** come from `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Each line carries `cwd`, `gitBranch`, and the message/tool transcript; the file stem is the session id and mtime is last-activity. See [[component_session_scanner]].

Sessions attach to a (project, branch) node by matching the jsonl's `cwd` + `gitBranch`. Opening a session runs `claude --resume <id>` in that cwd inside the [[component_pty_host]]; a fresh session just runs `claude`, and the new jsonl is picked up by the watcher.

## Why it's this way

A private/IPC API to Claude Code does not exist and would be version-fragile. The filesystem is already a complete, append-only record. Reading it (head-only, mtime-cached) is cheap enough to do live. The cost is a few data nuances that must be respected, see the gotchas below.

## Related

- Governed by [[adr_three_session_stores]] - scopes this page to the **derived** store. Tori also keeps a `set_session_name` rename overlay that is Tori-authored and deliberately not rebuildable, so "everything is derived from disk" is true of the session index and the tree, not of user-authored names.
- [[adr_stack_choice]] — the decision that picked manual config + auto-discovery.
- [[component_session_scanner]] — how the jsonl is read and indexed.
- [[component_pty_host]] — how a discovered session is resumed.
- [[gotcha_encoded_claude_dir_name_is_lossy]] — why `cwd` must be read from file contents.
- [[gotcha_gitbranch_is_recorded_at_session_creation]] — why some sessions don't match a live branch.
