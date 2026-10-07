---
summary: debug builds use ~/.config/tori-dev: target/debug/tori reaches Tori Dev, installed tori and MCP do not
status: current
updated: 2026-10-08
source: gettori/tickets#31 dogfood attempt on branch phase-1-block-1; src-tauri/src/owned_state.rs (config_dir)
---

# The debug CLI reaches Tori Dev, not the installed app

Do not test a branch's socket change with the installed `tori` or an agent's `tori mcp` tools: they read `~/.config/tori/rpc.json` and reach the installed app. Use `src-tauri/target/debug/tori`, which reads `~/.config/tori-dev/rpc.json`, and check the running Tori Dev started after that binary was built, since a refusal like "unknown field" means the process is older than its own binary. Why: `config_dir` picks `tori-dev` under `debug_assertions`, and `pnpm tauri:dev` can leave a running process behind a rebuild.

## Related

- [[component_tori_cli]]: the CLI that reads the bridge file
- [[component_app_socket]]: what the bridge file points at
