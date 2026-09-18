---
summary: probe a capability on the model it names, with a control on a second model, before building its toggle
status: current
updated: 2026-08-21
source: plan "Make the session controls tell the truth about the CLI" (phase 3), branch `chat`; `dev/protocol-probe.mjs` (`fast-mode` scenario); `dev/fixtures/claude/fast-mode.jsonl`; `src/panels/Chat/FastModeStatus.tsx`; commit "Measure fast mode before building a control for it"
---

# Probe the capability before building its control

A phase planned to ship a fast-mode toggle: a pill, a pending state, a catalogue gate, a mid-turn guard. It shipped **none of them**, because the first task was to probe whether the toggle could move at all and the answer was no. The plan had written that off-ramp in as a task with its own `verify:` ("no control ships that cannot be shown to move"), which is the only reason the phase ended in a measurement instead of a feature nobody could use.

## What happened

`/fast` is in the session's slash-command catalogue, describing itself as "Toggle fast mode (Opus 5)". That is exactly what an available capability looks like. Sending `/fast on` on Opus 5 - the model it names - answers `Fast mode unavailable: Fast mode is not available in the Agent SDK`, and `fast_mode_state` stays `"off"` on the sending turn's `system/init` **and** the next turn's, which is where a late change would have shown.

## What made the measurement trustworthy

- **Probe on the model the capability names.** `/fast` is Opus-5-scoped, so a refusal on any other model would have been ambiguous between "wrong model" and "this transport cannot".
- **Run a control on a second model.** The byte-identical refusal on `sonnet` is the only thing separating "this transport refuses" from "this model refuses". Without it the result would have been unusable.
- **Take a second turn.** `system/init` fires once per turn *at turn open*, so a state change landing late is invisible inside the turn that asked for it.
- **Separate a refusal from a no-op.** Here the harness said why, in its own words. The same transport also produced the opposite failure mode in another phase (`--permission-mode auto` on Haiku: exit 0, no warning, silently wrong), so both need to be distinguished explicitly rather than lumped into "it did not work".

## The trap

The planned gate was "ship the pill only when `/fast` is in the session's command catalogue". `/fast` **is** in the catalogue. That gate would have passed and shipped a dead control. Presence in a catalogue is not evidence of a capability, and neither is absence from one - see [[gotcha_a_capability_absent_from_the_control_request_api_can_still_be_in_the_slash_command_catalogue]], where the earlier conclusion was right for the wrong reason because it tested only the control-request API.

## How the finding is kept

The set-and-grammar fixture check cannot police this: a working toggle and a refusal emit identical frame kinds. So the `fast-mode` probe scenario asserts the measurement itself - two inits, the state never leaving `"off"`, the refusal text matching - and fails loudly the day a CLI opts the SDK in. That failure is the signal to build the toggle, not a bug. Demonstrated failing before it was trusted.

## Two more instances, 2026-08-21

Plan "The composer offers every lever the agent published" (branch `unified-chat`) applied this twice, and the second is the case this page did not have.

**Adaptive thinking, the same answer as fast mode.** A phase was scoped to "publish a working toggle if one is reachable, otherwise publish it refused". `--help` lists no thinking option at all, so the easy conclusion was unreachable. It is reachable: `--thinking bogus --version` answers `Allowed choices are enabled, adaptive, disabled` and exits 1, while each of the three passes silently. But `--thinking` is **argv**, fixed when the child spawns, and this transport has no mid-session verb for it, so the control shipped refused carrying that reason rather than as a toggle that would move nothing. Measuring changed the *sentence on the control*, not whether it shipped.

**The per-model option sweep, where the measurement said build it.** Every instance above ended in "so do not build the control". This one did not. The question was whether an ACP agent's option set varies by model, and `dev/acp-probe.mjs --per-model` switched model inside one session and diffed the answer: both agents re-cut their `thought_level` choices ([[concept_acp_config_options]]). So the cache really did have to key options per model row, and the work went ahead on evidence instead of on plausibility. **The discipline is not a bias against building.** It is a bias against building on a guess, and it pays out in both directions.

## What the fast-mode finding became

The refusal this page recorded is still true and is still published. What changed is where it comes from: the `initialize` catalogue publishes `supportsFastMode` per model, so `claude::config_options` reads the flag off the row rather than off a Tori-side table. The table restating it had been matching nothing the whole time, which is [[lesson_a_restatement_matches_nothing_and_says_nothing]].

Related: [[concept_capability_resolution]], [[lesson_debug_the_harness_before_recording_the_outcome]], [[lesson_a_restatement_matches_nothing_and_says_nothing]], [[component_catalog_probe]].
