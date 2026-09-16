---
summary: acp v1's set_config_option wants a bare string not a tagged object, configId on the call is id on the announcement
status: current
updated: 2026-08-21
source: plan "The composer offers every lever the agent published" (phase 3, personal/sway, branch `unified-chat`), `dev/acp-probe.mjs` (`measurePerModel`, `describeOption`), commit 462d734, [[concept_acp_config_options]], _2026-08-21_
---

# An ACP v1 config value is a bare string, not a tagged object

Do NOT hand-write `session/set_config_option` with `value: { type: "value", valueId: "x" }`. Why: the crate's `SessionConfigOptionValue::ValueId` serializes to a **bare string** on v1, so Rust reads naturally and misleads anyone writing JSON-RPC by hand. `opencode acp` 1.18.3 answers the tagged form with `Invalid params ... value: expected string, received object`. The same call also wants `configId`, while the option *announcement* that named it carries `id` (the v1 asymmetry [[concept_acp_config_options]] records) - reading `configId` off the announcement yields `undefined`, and both mistakes together produce one error listing three unrelated complaints. Both were made in `dev/acp-probe.mjs` and both are fixed there.
