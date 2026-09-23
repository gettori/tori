---
summary: codex's shell tool strips env vars matching *TOKEN*, *KEY*, *SECRET* by default, so a caller token named TORI_TOKEN never arrives
status: current
updated: 2026-09-23
source: gettori/tori#198 on branch orchestrator; commit ae2bbe65; src-tauri/src/rpc/mod.rs (ENV_CALLER)
---

# Codex's shell drops env names containing TOKEN, KEY or SECRET

Codex's shell environment policy carries default excludes for variable names matching `*KEY*`, `*TOKEN*` and `*SECRET*`, so a command its shell tool runs never sees them, even though the codex process itself was started with them. The socket's per child token was first called `TORI_TOKEN`: from a codex chat, `tori whoami` fell back to the bridge file and answered as an outside caller. It is `TORI_CALLER` (`rpc::ENV_CALLER`) for that reason, and any other env var an agent's shell has to see needs a name clear of those three words.

## Related

- [[component_app_socket]] - where the variable is minted
- [[component_tori_cli]] - the reader that fell back to the bridge file
