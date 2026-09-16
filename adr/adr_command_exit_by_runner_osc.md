---
summary: a command tab reports its own exit via a self deleting runner script printing OSC 8791 on the login shell it types into
status: current
updated: 2026-09-06
source: "plan \"Standalone terminals: Sway's own commands as tabs in a Shells workspace\" (personal/sway, branch `standalone-terminals`, issue #166), Phase 1; `src-tauri/src/runner.rs`, `src-tauri/src/pty.rs:384`, `src/panels/Terminal/TerminalView.tsx:318`; commit `aadacd3`"
---

# A command tab's exit comes from a runner script, on OSC 8791

A command tab hosts the user's login shell, so the PTY's own exit is the shell's and not the command's. The command reports for itself instead: `pty_spawn` writes a single-use POSIX script to `~/.config/sway/run/<nonce>.sh`, types ` sh '<path>'` into the shell as that tab's `init`, and the script prints `ESC ] 8791 ; <nonce> ; <code> BEL` before deleting itself. `TerminalView` registers an OSC handler for 8791 before the spawn and refuses any report whose nonce it does not recognise.

## Considered Options

- **A trap typed inline, ahead of the command** (rejected): it runs at the PTY's `MAX_CANON` alongside the command line, so a long command is truncated ([[gotcha_a_ptys_canonical_mode_truncates_a_single_long_typed_line]]); it needs a different form per shell, since fish has no POSIX `trap`; and a trap set on a line typed into the user's own shell **outlives the command**, so an interrupt leaves it installed in the prompt the user is now sitting at.
- **A sentinel parsed in the Rust PTY reader** (rejected): the reader would scan every byte of every command tab's output for a marker the command itself could print, and the marker would reach the screen.
- **A status file the frontend polls** (rejected): a poll interval is a latency floor on something that is already an event, and a crash leaves a file that outlives the answer it carried.
- **A self-deleting runner script** (chosen): the trap, the quoting and the 480-char bootstrap live in the file, so the typed line is one short path whatever the command is, the shell's echo of that line carries no escape bytes, the trap dies with the runner rather than leaking into the user's shell, and fish needs no branch because it only ever types `sh`.

## Consequences

- **An interrupt is a report, not a death.** The runner's `INT` trap reads `$?` rather than assuming 130, so a command that catches Ctrl-C and exits 0 is reported as 0, and it runs `trap - INT` first so a second Ctrl-C kills the runner instead of reporting twice. The hosting shell is untouched: after the interrupt the user is at a live prompt with the command's output still on screen. Proven on a real tty rather than in jsdom, by `runner.rs`'s `ctrl_c_reports_through_the_runner_and_leaves_the_hosting_shell_clean`.
- The nonce is minted by the backend, stored on the session, and returned by `pty_spawn` (again on a re-subscribe), so a remounted view keeps reading the running command's report. It is not a secret: the threat it answers is a replayed log, not a forgery.
- 8791 is outside every shell-integration range a user's rc may already emit (7, 9, 133, 633, 777, 1337), so a `starship` or VS Code prompt mark is never read as an exit code.
- Runners are written owner-only (`0o600`), because a clone URL can carry a token, and each deletes itself on every path. A startup sweep clears the ones a crash left behind. A spawn that fails after `write_runner` leaks one file until that sweep, which is accepted.
- The command runs under `sh`, not the login shell directly, but the login shell still **hosts** it, so PATH and environment come from the user's own profile. `env::augmented_path` is no longer used in `pty.rs`.
- The one-line ` sh '<path>'` still reaches shell history for users whose shell does not ignore space-led commands. Accepted: it is short and names nothing sensitive.

## Related

- [[concept_shell_hosted_tabs]] - the login-shell model this brings command tabs into
- [[component_pty_host]] - where the runner is written and the init delivered
- [[component_shells]] - the surface that consumes the report
- [[adr_jobs_leave_the_tab_model]] - the tab-model rule these commands come back under
- [[gotcha_a_trap_typed_into_the_users_own_shell_outlives_the_command_it_was_set_for]] - the rejected option, as a trap
- [[gotcha_a_ptys_canonical_mode_truncates_a_single_long_typed_line]] - why the typed line has to be short
