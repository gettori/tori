---
summary: the run command runs headless like setup, not in a terminal tab, so removal, quit and the sweep can see and stop it
status: current
updated: 2026-10-18
source: plan "Run and teardown commands beside the setup command" on branch phase-1-block-4, ticket gettori/tickets#41; src-tauri/src/run.rs
---

# The run command is headless, not a tab

A project's run command is started by Rust in the background with a log, through the same `Runs` core as setup and teardown ([[component_run_command]], [[component_worktree_setup]]).

## Considered Options

- **A task terminal tab**, the Scripts path. It gives live output and Ctrl+C, `pty_spawn` already sets the ports, and the daemon keeps it alive across an app restart. Rejected: only the webview knows a tab's exit, so removal, quit and the cleanup sweep would each have to reach into the webview to see or stop it. It would also split run from the two commands it sits beside.
- **Headless in Rust.** Chosen. It follows setup's style, removal and `RunEvent::Exit` stop it from Rust, and an agent never gets a tab it did not ask for.

## Consequences

- Output is a log file. Show log opens it in the editor, which may not tail a growing file.
- An app restart, an update included, stops every run, while a server in a terminal tab survives through the daemon.
- A headless run is invisible to the sweep's session and tab checks, so the cleanup verdict has its own `running` check ([[component_worktree_cleanup]]).
- A crash leaves groups behind, hence `runs.json` and the reap at launch.
- Port chips do not see a terminal go quiet, so portsStore rescans on run events ([[component_ports]]).
