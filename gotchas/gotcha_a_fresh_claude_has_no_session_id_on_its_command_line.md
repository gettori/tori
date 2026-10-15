---
summary: the running probe matches `--resume`/`--session-id <id>`, which a `claude` typed in a shell lacks, so it never reads live
status: current
updated: 2026-10-15
source: gettori/tickets#24 phase tori-attach, commit 244f5b94; src-tauri/src/agents.rs:1827; src-tauri/src/pty/host.rs:149 (handed_on); src-tauri/src/rpc/dots.rs (TabFact.held)
---

# A fresh claude has no session id on its command line

**The probe that says a session is running greps the process table for the agent with its session id on the command line (`agents.rs:1827`). A `claude` started by hand in a terminal tab has no `--resume` or `--session-id`, so its session never counts as running**, even though the hooks writer already bound it to the tab ([[component_claude_hooks_status]]). `tori sessions --live` came back empty and `tori attach` had nothing to resolve.

The fix reads the tab instead of the argv: `Pty::handed_on` (`pty/host.rs:149`) is true while the terminal's foreground process group is not the shell, read through the master the way the init seeder reads it. It rides on the PTY listing into the composed tab as `held`, and the composition counts a held, hooks-bound tab's session as running. The flip side is deliberate: a PTY session stays alive in `SessionStates` only while its tab is handed on, so quitting the agent back to the prompt ends it.

## Related

- [[gotcha_a_pgrep_running_pattern_must_allow_for_the_chat_transports_base_args]]: the same probe's other trap
- [[component_pty_host]]: where `handed_on` is read
