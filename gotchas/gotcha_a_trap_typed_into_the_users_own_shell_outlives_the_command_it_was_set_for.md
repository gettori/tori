---
summary: a shell trap set on the same line as a command belongs to the shell, an interrupt leaves it stuck in the live prompt
status: current
updated: 2026-09-06
source: "plan \"Standalone terminals: Sway's own commands as tabs in a Shells workspace\" (personal/sway, branch `standalone-terminals`, issue #166), Phase 1; `src-tauri/src/runner.rs` (`script`); commit `aadacd3`"
---

# A trap typed into the user's own shell outlives the command it was set for

Do NOT set a shell trap on the same typed line as a command in order to learn how that command ended. The trap belongs to the shell, not the command, so an interrupt leaves it installed in the prompt the user is now sitting at, and it has to fit under the PTY's `MAX_CANON` alongside the command line ([[gotcha_a_ptys_canonical_mode_truncates_a_single_long_typed_line]]). Put it in a script the shell runs instead, where it dies with the script. See [[adr_command_exit_by_runner_osc]].
