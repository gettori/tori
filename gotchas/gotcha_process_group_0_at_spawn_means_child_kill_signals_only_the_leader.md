---
summary: process_group zero puts a child in its own group, so kill only signals the leader, the real agent keeps running
status: current
updated: 2026-08-17
source: plan "Model catalogues from the harnesses themselves" (phase 3, personal/tori, branch `settings-and-chat`); `src-tauri/src/catalog_probe.rs::abandon_group`; `src-tauri/src/dap.rs::stop`
---

# `process_group(0)` at spawn means `child.kill()` signals only the leader

Do NOT pair a process group with a plain `Child::kill`. Setting `process_group(0)` puts the child in its own group, which is what makes a wrapped agent (`npx`, `bun`, `uvx`) killable at all - and `kill()` then signals **only the group leader**, leaving the real agent running under a wrapper that has exited. A chat session survives this because the ownership registry notices orphans; a fire-and-forget probe has nothing watching, so every probe would leak an agent. Tear the group down explicitly (`kill -KILL -<pid>`, as `dap.rs::stop` already did) and then reap the child. The failure is invisible in tests and on a machine where the agent happens not to be wrapped, which is exactly why the two halves get written months apart.
