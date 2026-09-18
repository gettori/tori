---
summary: a rejected control request is not proof a capability is missing, probe the slash command catalogue too
status: current
updated: 2026-07-29
source: Make the session controls tell the truth about the CLI, phase 3 (personal/tori, branch `chat`); `dev/protocol-probe.mjs` (`fast-mode` scenario), `dev/fixtures/claude/fast-mode.jsonl`, `src/panels/Chat/FastModeStatus.tsx`; [[concept_harness_capability_tiers]]
---

# A capability absent from the control-request API can still be in the slash-command catalogue

Do NOT conclude a harness cannot do something because the obvious control request is rejected. `set_fast_mode` answers `Unsupported control request subtype`, and that was taken as proof no request turns fast mode on - but `/fast` is right there in the `initialize` response's `commands` list, describing itself as "Toggle fast mode (Opus 5)". The two surfaces are separate vocabularies and neither is a superset of the other, so a negative result on one says nothing about the other. Probe both before shipping the conclusion. Here the second route refused too ("Fast mode is not available in the Agent SDK"), so the original decision stands, but it stood on one measurement out of two. Two further traps in the same probe: send the slash command on the model it names (`/fast` is Opus-5-scoped, so a refusal elsewhere would be ambiguous) and run a **control on another model**, since that is the only thing separating "this transport refuses" from "this model refuses"; and take a **second turn**, because `system/init` fires once per turn at turn open, so a state change landing late is invisible inside the turn that asked for it. The set-and-grammar fixture check cannot catch a regression here at all: a working toggle and a refusal emit identical frame kinds, so the measurement has to be asserted in the scenario itself.
