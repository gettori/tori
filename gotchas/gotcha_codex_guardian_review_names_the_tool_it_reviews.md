---
summary: codex-acp's Guardian Review tool call names the tool it reviews, so match a call by title suffix then follow its id
status: current
updated: 2026-09-23
source: plan "Probe: --mcp-config beside --settings" (phases 3 and 4), branch `orchestrator`; `dev/mcp-probe.mjs` (`acpCeiling`); codex-acp 1.12.0 on codex-cli 0.155.1
---

# codex's Guardian Review names the tool it reviews

Do NOT find an ACP tool call by searching its frame, or even its title, for the tool's name. On codex-acp 1.12.0 an MCP call arrives as two tool calls: the real one titled `mcp.<server>.<tool>`, and a `Guardian Review` call whose frame also names that tool. A matcher that takes the first hit, or the last terminal status after it, reports the review's few seconds as the call's duration. Once the review reported its 6s completion as a 32-minute call. Match on the title's suffix, keep that `toolCallId`, and read status only from frames carrying it. Related: [[concept_acp_agent_quirks]], [[concept_blocking_tool_call_ceiling]].
