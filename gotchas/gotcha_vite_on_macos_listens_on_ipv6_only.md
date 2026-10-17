---
summary: Vite binds localhost, which macOS resolves to ::1, so a 127.0.0.1 connect probe misses it; probe both or ask lsof
status: current
updated: 2026-10-17
source: "plan \"Per-worktree ports and dev server URLs\" (personal/tori, branch `phase-1-block-4`, gettori/tickets#40); `src-tauri/src/ports.rs` (`answers`)"
---

# Vite on macOS listens on IPv6 only

Node resolves `localhost` in the OS's order, and macOS puts `::1` first, so a Vite dev server listens on `[::1]:5173` and nothing else. A check that connects to `127.0.0.1:5173` is refused and reports the port free, or the server down.

`python3 -m http.server` binds `0.0.0.0` by default, so a test written with it passes while the real case fails. Test with `--bind ::1`.

Fix: probe both `127.0.0.1` and `::1` (`answers` in `ports.rs`), or ask `lsof -iTCP -sTCP:LISTEN`, which lists IPv4, IPv6 and wildcard binds alike.

## Related

- [[component_ports]] - where both the allocation probe and the scan handle it
