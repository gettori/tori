---
summary: ports.rs hands each checkout a stable TORI_PORT block from ports.json and finds dev servers per worktree by lsof cwd
status: current
updated: 2026-10-28
source: "plan \"Per-worktree ports and dev server URLs\" (personal/tori, branch `phase-1-block-4`, gettori/tickets#40); `src-tauri/src/ports.rs`, `src/utils/portsStore.ts`; plan \"Shareable project config in the repository, trust-gated\" (branch shareable-project-config, gettori/tickets#49)"
---

# Ports

`src-tauri/src/ports.rs` does two independent jobs: it gives every checkout a block of ten ports, and it finds the servers actually listening from each worktree. The second does not depend on the first, so a server shows up on any port it picked ([[adr_ports_shown_by_cwd_scan_allocated_by_registry]]).

## Responsibility

- **The registry** is `~/.config/tori/ports.json` (`tori-dev` for a debug build), a map from canonical checkout root to the first port of its block. Release builds allocate in 40000 to 44990, dev builds in 45000 to 48990, both below the macOS ephemeral range at 49152.
- **The root** of a cwd is the nearest folder with a `.git` (`root_of`, `ports.rs:72`). A `.git` file whose gitdir sits under `modules` and not directly in `worktrees` is a submodule, so a submodule shares its superproject worktree's block, while a worktree of a submodule repo is its own root.
- **Allocation** (`block_for`, `:97`) is lazy, on the first spawn in a checkout, the main checkout included. A hit reads the file unlocked, because `pty_spawn` calls it on the sync IPC thread. A miss takes an `flock` on `ports.lock`, since the app and the daemon both spawn. It drops entries whose folder is gone, then takes the first free block where no port answers a connect on `127.0.0.1` or `::1` ([[gotcha_vite_on_macos_listens_on_ipv6_only]]).
- **Release**: `do_remove_worktree` canonicalizes the path before the folder moves to the trash, then calls `release` (`worktree.rs:907`). A folder deleted outside Tori is dropped at the next allocation miss.
- **The scan** (`ports_scan`, `:163`) runs `lsof -b -w -nP -iTCP -sTCP:LISTEN`, then `lsof -d cwd` for those pids, and gives each port to the deepest worktree containing its cwd (`attribute`, `:243`). Listeners outside every worktree are dropped, and so are the pids of Tori's own language servers and debug adapters (`LspState::pids`, `DapState::pids`). A timed out `lsof` answers with the previous scan (`remember`, `:174`).

## Interface

- `env_for(cwd)` returns `TORI_PORT` and `TORI_PORT_1` up to `width(root)` variables, or nothing outside a checkout. `width` is the user's `WorktreePrefs.ports` (the deepest canonical key holding the root), else the accepted repo `ports` ([[concept_repo_proposals]]), clamped to 1..10. The allocator stays 10 wide, so a width never moves a block. It is layered into `setup::Runs::start` (`setup.rs:182`, so setup, run and teardown all get it), `pty_spawn` (`pty/mod.rs:396`) and `chat::transport::build_command` (`chat/transport.rs:73`). `PORT` is deliberately not set.
- `ports_scan(worktrees)` returns the listening ports keyed by the paths as given.
- `src/utils/portsStore.ts` holds one scan for every consumer. `portsAt(path)` adds a path for the life of the calling owner. The store has no timer: it scans on focus, 3 s after any `pty://activity` quiet, 3 s after a run command starts and at once when it stops (`setup://changed` with kind run, since a headless run has no terminal to go quiet), and again when a path was added mid-scan.
- Shown as `:<port>` chips in the worktree row's end cluster in `LeftSidebar.tsx`, brand amber while `extensionConnected()` (read from `browser_status` after a scan that found a port), and as `localhost:<port>` rows at the top of `ScriptsSection.tsx`.
- `openPort` calls `browser_open(port)`, which builds `http://localhost:<port>/` in Rust, records it with the daemon (`browser.opening`, 1 s cap) and opens it ([[adr_tori_opens_the_url_the_extension_folds_the_tab]]). `open_in_browser` is the same path for the run watcher.
- The `ports.scan` office op takes `exclude` as optional, so a caller without the window's LSP and DAP pids (the run watcher) keeps the last exclusion.

## Related

- [[gotcha_git_worktree_list_reports_canonical_paths]] - why both the registry keys and the attribution compare canonical paths
- [[adr_no_sync_ipc_commands]] - why the registry hit path stays unlocked
- [[component_run_command]] - the headless run whose events trigger a rescan
