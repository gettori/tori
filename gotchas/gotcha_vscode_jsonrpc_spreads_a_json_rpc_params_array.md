---
summary: vscode jsonrpc reads a bare array params as positional args and spreads it, a big catalog arrives as one entry
status: current
updated: 2026-08-08
source: "Editor wave 7: language intelligence depth, Phase 5 (personal/sway, branch `wave-7`); `src/panels/Editor/lspClient.ts:321`; commit a620384"
---

# `vscode-jsonrpc` spreads a JSON-RPC `params` array

Do NOT send a list as the bare `params` of a notification to a `vscode-jsonrpc` server. It reads a JSON-RPC `params` *array* as a positional argument list and spreads it across the handler, so a 1281-entry `json/schemaAssociations` catalog arrives as **one** association, with no error anywhere and a server that simply knows about one schema. Wrap it: `[associations]` is one positional argument that happens to be a list. Why: the encoding is ambiguous between "the arguments" and "an argument that is a list", and the library picks the first.
