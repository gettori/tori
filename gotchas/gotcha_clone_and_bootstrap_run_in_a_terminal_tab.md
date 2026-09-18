---
summary: git clone and bootstrap run in a real terminal tab for native progress and ambient auth, args stay positional
status: current
updated: 2026-06-30
source: Worktree-aware tree (personal/tori, branch code-mirror-6); `src/components/Sidebar.tsx` (`BOOTSTRAP_SCRIPT`), `src/components/TerminalArea.tsx`; commit 8ceb6e2
---

# Clone and bootstrap run in a terminal tab

Run `git clone` and the bare+worktree bootstrap **in a real terminal tab** (`OPEN_TERMINAL` → `pty_spawn`), not a captured backend `Command`: you get native progress and **ambient git auth** (credential helper / ssh-agent prompts) with no in-app credentials. Pass user input (URL, name) as **positional args** (`sh -c SCRIPT tori "$url" "$name"`), never interpolated into the script string, so there is no shell injection. The bootstrap is a `( set -e … ) || { rm -rf "$proj"; exit 1; }` one-liner: shell-native cleanup means no exit-code plumbing. A **SIGKILL** (closing the tab) skips the `|| rm`, leaving a `.bare`-only dir - caught by discovery's `incomplete` kind and a UI cleanup affordance, so it degrades to a cleanable stub, never a dead project. **Auth rationale superseded by [[adr_git_integration_auth]]** (askpass/editor bridge replaces the tab for credentials); the positional-args injection safety and `|| rm -rf` / `incomplete`-stub cleanup here still stand.
