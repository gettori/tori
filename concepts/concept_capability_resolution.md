---
summary: capabilitiesFor intersects adapter capability with the live model's flags for what a control offers, not what it shows
status: current
updated: 2026-07-30
source: plan "Make the session controls tell the truth about the CLI" (all five phases), branch `chat`; `src/utils/chatModels.ts` (`capabilitiesFor`, `contextWindowFor`, `modeAfterModelSwitch`); `src-tauri/src/agents.rs` (`resolve_mode`, `default_mode`); `src-tauri/agents/claude.toml`
---

# Capability resolution for session controls

Every session control (model, effort, permission mode, fast mode, the context meter) answers two different questions, and conflating them is what let Tori offer things the CLI would not do. **What a control may offer** is the adapter's declaration *intersected* with the live model's flags. **What a control shows as the current value** comes from a stated precedence: what the running session reported, then what the adapter declares, then nothing at all. "Nothing" is a real answer and renders as an absent control, never as a guess.

## How it works

- **Neither source alone is enough, and Haiku is the proof.** The live `initialize` catalogue declares per-model flags (`supportsEffort`, `supportedEffortLevels`, `supportsAutoMode`); every model carries them except Haiku, which omits the keys entirely rather than declaring them false. The adapter TOML declares what the *harness* can do (which modes exist, what they are called, what hint to show). A control offers the intersection: `capabilitiesFor(model, chat)` in `chatModels.ts`.
- **A gate is declared, never keyed on an id.** `auto` is hidden for a model lacking the capability because the mode row says `requires = "supportsAutoMode"`, not because code checks for the string `"auto"`. Same reasoning as `permissive_caveat`, which replaced a check against the literal `"bypassPermissions"`. The pairing of a mode name to a flag name is a property of one harness, and hardcoding it puts that harness's vocabulary inside a neutral resolver.
- **The value's precedence order** (`contextWindowFor`): what the session reported → what the adapter declares → a catalogue lookup for non-Claude ids only → null. Written-down figures are provisional and get overridden the moment a live reading lands, rather than the two disagreeing forever.
- **A stale value downgrades, it does not fail.** `ChatConfig::resolve_mode` falls back to the mode marked `default = true` and reports what it dropped, so a settings file holding a mode the TOML no longer declares still starts a session. The marked default matters: the fallback must never be the Claude literal `"default"`, which names nothing on a harness whose modes are `auto_edit|yolo`.
- **A gate is walkable from one control away.** Hiding the `auto` row does nothing about a mode already in force, so picking `auto` on Sonnet and switching to Haiku left the session asking for a mode the CLI silently ignores. `modeAfterModelSwitch` re-resolves the mode on a model switch, falling back to the default *among what is still offered*.

## Why not the alternatives

- **A fixed enum of modes.** It was one, and it could not represent Codex, which lists its permission profiles at runtime via `permissionProfile/list`. Worse, the enum had already caused the substitution it existed to prevent - see [[gotcha_replacing_an_enum_with_a_string_silently_disarms_a_compile_time_check]].
- **Trusting that an accepted flag is an honoured one.** Measured on claude 2.1.220: `--permission-mode auto` on a model without `supportsAutoMode` exits **0 with no warning** and reports `permissionMode: "default"`. Acceptance is argument validation; whether a flag is honoured is a per-model runtime property, which is why the gate is declared rather than probed.
- **Encoding a rule for a value the harness already reports.** The context window was going to be a base/extended/provider table in TOML. It did not need to be - see [[gotcha_the_harness_may_already_report_what_you_are_about_to_declare]].
- **Guessing by model family.** `staticCap` said "sonnet and opus are 1M, other Claudes 200k". Right for two models by luck, and a guess that happens to be right still goes stale silently.

## Where it shows up

- [[component_chat_model_resolver]] - the module every surface reads.
- [[concept_harness_capability_tiers]] - the same "measured outcomes, not feature names" rule, one level up at the harness rather than the model.
- [[concept_transport_neutral_event_model]] - why a mode is a string the adapter names rather than a variant Tori enumerates.
- [[lesson_probe_the_capability_before_building_its_control]] - what to do when a capability looks available and is not.
