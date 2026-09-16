---
summary: comparing an ACP adapter to a catalog entry by program name misses npx launches, so untested agents look covered
status: current
updated: 2026-08-14
source: Defer permissions to the harness, and grow to four harnesses, phase 8 (personal/sway, branch `chat-fix`); `src-tauri/src/catalog.rs:154`; [[component_acp_catalog]]
---

# A chat binary that is a package runner breaks any comparison by program

Do NOT compare an adapter to a catalog entry by program name once any adapter launches its chat through `npx`, `bunx` or `pnpx`. `codex.toml` launches `codex` but chats through `npx -y @agentclientprotocol/codex-acp@1.2.0`, so a program comparison made **every `npx` row in the ACP registry** read as "already covered by Codex" and the catalog quietly stopped offering agents Sway has never measured. Compare launch *identity* instead: skip flags, take the first bare argument, strip the version pin (`catalog.rs:154`). Note `agentIdForProgram` on the frontend still has the weakness, with the limitation named at the code.
