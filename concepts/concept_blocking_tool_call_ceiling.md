---
summary: MCP calls block for hours on claude if Tori sets the server timeout, codex-acp kills them at 300s, so ask_user polls
status: current
updated: 2026-09-23
source: plan "Probe: --mcp-config beside --settings" (phase 4), branch `orchestrator`; `dev/mcp-probe.mjs --ceiling`; claude 2.1.280, codex-acp 1.12.0 on codex-cli 0.155.1, pi-acp 0.0.33 on pi 0.82.1
---

# How long a tool call may block

**`tori_ask_user` cannot rely on blocking: claude will wait for hours if Tori configures it to, codex-acp gives up at 300 seconds whatever the server does, so the tool returns an id and the answer is polled.** A blocking path on claude alone is an optimisation layered on that, not the design.

## How it works

Every number below is a call to the probe's `tori_probe_sleep` over stdio, timed from the harness's own frames (`node dev/mcp-probe.mjs --ceiling`, flags in `ceiling()`). The probe first proved it can see a give-up at a time it chose (`--calibrate`), so "completed" here means the harness really did wait.

| Harness | Setting | Result |
|---|---|---|
| claude 2.1.280 | defaults, silent call | gave up at 1800s: `sent no response or progress for 1800s; aborting` |
| claude 2.1.280 | defaults, progress every 60s | completed a 1920s call |
| claude 2.1.280 | per-server `timeout: 20000` | gave up at 20.0s: `timed out after 20s`, then `notifications/cancelled` to the server |
| claude 2.1.280 | per-server `timeout: 1e10`, silent | completed a 2100s call, no cap found at 2100s |
| claude 2.1.280 | `timeout: 15000`, progress every 2s | gave up at 15.0s, progress does not stretch the hard limit |
| claude 2.1.280 | idle env 8000, progress every 2s | completed a 60s call, progress resets the idle timer |
| codex-acp 1.12.0 | defaults, silent | failed at 300s: `timed out awaiting tools/call after 300s` |
| codex-acp 1.12.0 | progress every 10s | failed at 300s, progress does not extend it |
| pi-acp 0.0.33 | none | unmeasured, see below |

**claude has two clocks, not one.** A hard wall clock (per-server `timeout`, else `MCP_TOOL_TIMEOUT`, else a default of 1e8 ms, about 27.8 hours) and an idle clock (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, 30 minutes for stdio by default, reset by progress). The binary raises the idle clock to the per-server `timeout` whenever one is set, and clamps both at 2^31-1 ms (about 24.8 days). So the range Tori controls is: 30 minutes of silence at defaults, 27.8 hours if the server sends progress, and up to 24.8 days of silence with a per-server `timeout`. The 27.8 hour default and the 24.8 day clamp are read from the 2.1.280 binary, not waited out. An idle setting below 30s was raised to 30s.

**The per-server key is `timeout`, in milliseconds**, measured at 20s and 15s above. The binary's help text names the setting `toolTimeout`, but `timeout` is the key that took effect here, and `toolTimeout` was never tried. Values under 1000 fall through to the env var.

**codex-acp has one clock and Tori cannot reach it.** 300s, progress or not, and ACP's stdio server entry (`name`, `command`, `args`, `env`) has no field to raise it. Codex's own per-server timeout lives in `~/.codex/config.toml`, which is the user's file.

**claude sends a `progressToken` on every `tools/call`, and codex-acp does too.** So progress is available on both. It just only buys time on claude.

## Why it is this way

**pi is unmeasured, not omitted.** pi-acp 0.0.33 accepts `mcpServers` and never starts the servers ([[concept_acp_agent_quirks]]), so there is no MCP call to time, and pi returned no model text on the machine this was measured on, so a slow built-in command could not be timed either.

**A long call stays in the turn under `-p`.** The binary also has an auto-background path for long MCP calls (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`), and it is off in a `-p` session unless `CLAUDE_AUTO_BACKGROUND_TASKS` is set. Tori's chat transport runs `-p` and sets neither, so a long call stays in the turn.

## Related

- [[concept_mcp_config_scopes]]: where the per-server `timeout` would be written, in the `--mcp-config` file Tori injects
- [[concept_acp_agent_quirks]]: which ACP agents start the server at all
- [[concept_harness_capability_tiers]]: where a per-harness blocking ceiling would be published
- [[adr_a_background_session_needs_a_tori_gate]]: the `ask_user` approval this ceiling constrains
