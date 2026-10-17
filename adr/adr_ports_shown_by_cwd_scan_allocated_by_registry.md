---
summary: dev server links come from an lsof scan by cwd, not the port block; blocks are opt-in via TORI_PORT and PORT is never set
status: current
updated: 2026-10-17
source: "plan \"Per-worktree ports and dev server URLs\" (personal/tori, branch `phase-1-block-4`, gettori/tickets#40); `src-tauri/src/ports.rs`; Orca read at stablyai/orca `6fcc183a`, `src/main/ports/`"
---

# Links come from a cwd scan, blocks from a registry

Tori finds dev servers by asking `lsof` for every TCP listener and attributing each one to the deepest worktree containing its cwd. Separately, it gives every checkout a stable block of ten ports as `TORI_PORT` to `TORI_PORT_9`. The links never read the registry ([[component_ports]]).

## Considered Options

- **Probe only the worktree's block** with a connect per port. It is cheap and spawns no process, but it shows nothing for a server that did not read `TORI_PORT`. Vite and Next move to the next free port on their own, so in practice that is most servers, and every project would need its scripts edited before a link appeared. Rejected.
- **Scan only, no registry** (Orca's approach). It needs no setup, but an agent cannot know its port before starting a server, URLs change with whoever wins the race, and servers that refuse to move (Express, Rails, Vite with `strictPort`) still collide. Rejected as incomplete.
- **Scan plus registry.** Chosen. The scan makes the links work with no setup, and the registry gives agents a port up front plus stable URLs for the browser preview.
- **Also set `PORT` to `TORI_PORT`**, so Next, Express and Nuxt use the block with no edits. Rejected: a monorepo worktree that runs two such servers from one `dev` script would put both on one port, a collision Tori would cause. Using the block is opt-in.

## Consequences

- Every poll spawns two `lsof` processes. Polling runs only while the window is visible and is never concurrent with itself.
- Any TCP listener in a worktree gets a link, `node --inspect` included. Only Tori's own language server and debug adapter pids are filtered.
- A server started in a terminal outside Tori shows up too, because attribution is by cwd and not by parentage.
