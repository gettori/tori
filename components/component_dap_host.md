---
summary: DAP host dials into a debug adapter that listens on a socket rather than stdio, and one server serves many connections
status: current
updated: 2026-08-11
source: "Editor wave 8: the debugger (DAP) (personal/sway, branch `wave-8`); Phases 1-2; epic #69, sub-issues #70/#71; commits cdb4cd2, 1e72ae1"
---

# DAP host: an adapter registry that spawns a server and dials in

**Location:** `src-tauri/src/dap.rs`, `src-tauri/src/dap/registry.rs`, `scripts/install-dap.mjs`, `src-tauri/resources/dap/manifest.json`

The Rust half of debugging: a registry of debug adapters keyed by id, and a transport that spawns one, waits for it, connects, and pumps `Content-Length` frames to a `Channel<String>` per session. Deliberately shaped after [[component_lsp_host]], and deliberately different in the one place that matters: **an LSP server speaks stdio and a DAP adapter listens**.

## The shape LSP does not have

`vscode-js-debug`'s `dapDebugServer.js` calls `net.createServer(...).listen({path})` and waits. It is not a stdio adapter, so nothing about `lsp.rs`'s stdin/stdout pair carries over; only the framing does. `dap_start` (`src-tauri/src/dap.rs:288`) spawns the adapter with a socket path, connects with **retry-and-backoff under a timeout**, and returns the handle.

- **A short random name under `$TMPDIR`, never workspace-derived.** Darwin caps `sun_path` at 104 bytes and macOS's `$TMPDIR` alone eats 49 (see [[gotcha_darwin_caps_unix_socket_paths_at_104_bytes]]).
- **The readiness line is logged, never parsed as a gate.** `Debug server listening at <path>` is unversioned English, and a reword would hang the host forever. Phase 1 measured **6 attempts / ~106 ms** across five runs, with an immediate single connect failing **100%** of the time: the race is deterministic, not a rare flake.
- **One server, many connections.** `dap_connect` (`:347`) opens a *second* socket to a server already running, which is what serves `startDebugging` (see [[concept_dap_session_tree]]). Each connection is its own session id with its own reader thread and `Channel<String>`.
- **`root_for_adapter` (`:439`) resolves the debuggee's `cwd` in Rust and nowhere else**, for the reason `(server_id, root)` keying exists on the LSP side: `cwd` decides module resolution *and* source-map location, so a workspace-root default is the same mistake with a wider blast radius.
- **Install under the second lock, and stop means kill *and* reap**, both carried over from `lsp.rs` rather than re-derived.
- **Termination is target-kind-dependent.** `terminateDebuggee: true` on an attach would destroy a process Sway never started, so launched debuggees are killed and attached ones never are.

## Acquisition: the manifest is tracked, the artifact is not

`vscode-js-debug` is **not on npm**. `scripts/install-dap.mjs` downloads the pinned GitHub release tarball (`js-debug-dap-v1.117.0.tar.gz`, 1.2 MB / 70 files), verifies a sha256 and extracts into `src-tauri/resources/dap/`, mirroring `lsp:install`. Only `manifest.json` is committed; the extracted tree is gitignored and reaches a packaged build through a `tauri.conf.json` resource glob.

**The install script is where bundle assumptions are checked.** It rediscovers the reverse-request names structurally from the bundle and fails the install if they no longer match `REVERSE_REQUESTS`. That is how Phase 2 found `remoteFileExists`, which neither the plan nor two adversary passes had. A js-debug bump therefore fails loudly at install rather than quietly at runtime.

## Key files & entry points

- `src-tauri/src/dap.rs:288`, `dap_start`: spawn, wait, connect
- `src-tauri/src/dap.rs:347`, `dap_connect`: a second connection to a live server
- `src-tauri/src/dap.rs:396`, `dap_stop` / `:407` `dap_stop_all`: kill the process group and reap
- `src-tauri/src/dap.rs:439`, `root_for_adapter`
- `src-tauri/src/dap/registry.rs`, adapter id to launch and claimed extensions; built for N, one entry ships
- `scripts/install-dap.mjs`, pinned download, sha256, structural bundle checks

## Connections

- Mirrors [[component_lsp_host]], same registry, same install-under-second-lock, same kill-and-reap; different transport
- Used by [[component_debug_session_tree]], every frame in and out
- Feeds [[component_debug_launch]], `dap_root_for` and `dap_launch_env`
- Health cards follow [[component_agent_health_cards]]'s neutral-unknown rule

## Related

- [[concept_dap_session_tree]], why one server must accept many connections
- [[gotcha_vscode_js_debug_is_not_on_npm_and_listens_rather_than_speaking_stdio]]
- [[gotcha_darwin_caps_unix_socket_paths_at_104_bytes]]
- [[gotcha_gui_launched_processes_inherit_a_minimal_path]], why `dap_launch_env` exists
- [[lesson_a_registered_command_with_no_caller_is_not_shipped]], the `generate_handler!` test covers `dap.rs` too

## Does NOT

Bundle a Node runtime (system `node`, like the LSP host), support any adapter but js-debug without a registry entry, parse the adapter's readiness line, or kill a process it did not start.
