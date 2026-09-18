---
summary: a bare Command::new for a network git operation has no askpass bridge and hangs instead of prompting for credentials
status: current
updated: 2026-08-03
source: "Editor Wave 3: GitHub as a first-class surface (personal/tori, branch `wave-3`); Phase 9 self-review; `src-tauri/src/git.rs:250`; commit ce1c941"
---

# Every network git op must be built with `git_command`

Don't reach for a bare `Command::new("git")` for anything that touches a remote. Why: without the askpass bridge's env there is no TTY and no credential source, so the process hangs instead of prompting ([[concept_askpass_bridge]]). The pull-request head fetch shipped this way once and self-review caught it; the rule is `git_command(repo, op_id, sock, token)` for fetch, push, clone and anything else that opens a connection.
