---
summary: in a Tori session the CLI follows TORI_SOCK to the release daemon; dev tests need it unset, temp HOME, trust
status: current
updated: 2026-10-21
source: gettori/tickets#43 on branch scheduled-runs, plan "Scheduled runs"; commits 0cdcf86b, ee900c1d, f5e7ccb4; src-tauri/src/cli.rs (connect); src-tauri/src/owned_state.rs (config_dir); src-tauri/src/trust.rs (allows_git)
---

# Inside a Tori session the CLI reaches the release daemon through `TORI_SOCK`

A shell Tori spawned carries `TORI_SOCK` and `TORI_CALLER`, and the CLI connects there before it reads any `rpc.json`. So `./target/debug/tori autopilot ...` talks to the installed app's daemon and answers `no method` for anything new. To test a debug build's daemon live without touching your own `~/.config/tori-dev`:

1. `mkdir -p /tmp/h/.config/tori-dev`; the daemon exits at once, "its starts cannot be counted", without it.
2. Write `/tmp/h/.config/tori-dev/trusted.json` as `{"trusted": ["<project>"]}`: every git call is trust-gated, so an untrusted project reads as not a repository.
3. For autopilot work, `settings.json` there with `{"autopilot": {"available": true}}`.
4. Run both daemon and CLI as `env -u TORI_SOCK -u TORI_CALLER HOME=/tmp/h ./target/debug/tori ...`.

## Related

- [[component_tori_daemon]]: the daemon this starts
- [[component_tori_cli]]: how the CLI finds a socket
