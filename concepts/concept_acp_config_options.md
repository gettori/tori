---
summary: every mid session model or mode switch travels as one set_config_option verb matched by category, never by id
status: current
updated: 2026-09-04
source: "\"Defer permissions to the harness, and grow to four harnesses\" (phases 4, 6 and 8, branch `chat-fix`); `src-tauri/src/chat/acp.rs:129-248`; `src-tauri/src/chat/acp_transport.rs:100` (`ConfigOption`), `:177` (`Switch`); measured against `opencode acp` 1.18.3 and `@agentclientprotocol/codex-acp` 1.2.0; per-model variation added by plan \"The composer offers every lever the agent published\" (phase 3, branch `unified-chat`, commit 462d734); `dev/acp-probe.mjs --per-model`; confirmation rules added by plan \"Confirm an ACP mode or model switch from the agent's own answer\" (branch `bugfix-260903`, issue 164, commit 1aedc0b); `src/panels/Chat/chatStore.ts` (`confirmMode`, the `configOptions` arm); `acp_transport.rs` (`switch_events`)"
---

# ACP config options: how a model, mode or effort switch travels

Everything a user can switch mid-session in an ACP chat travels as **one verb**: `session/set_config_option`. Not `session/set_model`, which does not exist in the crate at all, and not `session/set_mode`, which does exist in the spec and which **no measured agent answers**. The agent publishes its selectors at `session/new` and the client picks the one it wants **by category**, never by id.

This is the single most load-bearing protocol fact in Tori's ACP client, and it is easy to get wrong in a way that looks like it works.

## How it works

An agent answers `session/new` with a set of `SessionConfigOption`s. Each carries a `category`, an id, a current value and its options. Tori gives three categories a bespoke control:

- `Model` and `ModelConfig` -> the model picker (`acp.rs:129`)
- `Mode` -> the permission-mode picker (`acp.rs:185`)
- `ThoughtLevel` -> reasoning effort (`acp.rs:227`)

**Everything else is kept and rendered generically** rather than ignored, which it used to be; see [[concept_generic_config_mirror]]. The same `config_options` mapping feeds the chat's mirror and the probe cache, so Settings can preview an agent's options before any chat exists.

To switch, Tori sends `session/set_config_option` with that selector's **`configId`** and the chosen value. `acp_transport.rs`'s `ConfigOption` enum names the three so a failure can say which one it was, and `Switch` (`Unknown` / `Unsupported` / `Available(config_id)`) records per session whether the agent published each selector at all.

**The response is checked, not assumed.** The agent answers with its whole option set, so it says what is *now* selected, which need not be what was asked for. An agent that accepts the request and keeps running the old model is exactly the silent mismatch a picker must not have.

## How a switch is confirmed

**The answer is the confirmation, because nothing else on this transport ever is.** Claude re-declares the mode and the model on every turn's `system/init`, and the store's `noteMode` / `noteModel` settle a pending pick there. ACP has no such boundary: `SessionStarted` is emitted once at adoption and `TurnStarted` never. Until issue 164 that left `pendingMode` and `pendingModel` with nothing to clear them on codex, opencode and every other ACP agent, so "applies from the next turn" stayed on screen for the session. The answer to `session/set_config_option` is re-emitted whole as `ChatEvent::ConfigOptions`, and the `mode` and `model` selects carry `current`; the store's `configOptions` arm reads those by category (`currentOf`) and settles on them. Claude's own `ConfigOptions` carry no category, so the same arm is a no-op there.

**Mode and model do not follow the same rule, because they do not travel at the same time.** A mode pick is staged in the transport (`pending_mode`) and sent *with the next prompt*, since applying a mode mid-turn would change the rules under a tool call in flight. A model pick is sent at once and answered in order on one channel. So a model answer that lands between a mode pick and its prompt still names the *old* mode, and settling the mode on it would erase a pick the transport is still holding. Hence `confirmMode`: the reported mode is recorded, but `pendingMode` clears only on equality. A model pick settles either way: an answer that names another model means the pick did not take, and the pick's `modelValue` goes with it, because `selectedModel` ranks a picked value above the reported id and would otherwise keep naming a model the session left ([[gotcha_a_store_field_with_one_writer_cannot_double_as_a_provisional_value]]). A repeated `SessionStarted` (an ACP reload re-announcing the session) follows the mode rule for the same reason.

**A mode that did not take is `ModeRefused`, for all three ways it can fail.** `switch_events` in `acp_transport.rs` turns an error, an answer naming another mode, and an answer naming no mode at all into the same event, so the store settles the pick with the agent's reason instead of promising the mode forever; a model keeps its plain `SessionError`, since its pick is settled by the option set. A mode reported in force clears its refusal note, because a transient mismatch is not claude's launch-time bypass rule. See [[gotcha_an_acp_mode_pick_is_staged_until_the_next_prompt_a_model_pick_is_answered_at_once]].

**The invoke resolving is not acceptance.** `chat_set_mode` resolves on staging and `chat_set_model` on enqueue (`send_command` is an `unbounded_send`), so the tab's draft pick and the project prefs are written when the `configOptions` answer confirms the asked value, not in the invoke's `.then`. Claude keeps the `.then` path behind `pickRidesArgv`. See [[gotcha_an_acp_chat_set_mode_or_chat_set_model_resolving_is_not_acceptance]].

**A value's shape is not free-form.** A select's value travels as a `SessionConfigOptionValue::ValueId`, a boolean's as `Boolean { value }`. Sending the *string* `"true"` for a toggle is a value id, and an agent given the wrong shape either refuses or silently does nothing, so the mapping is a tested function (`acp_transport::option_value`) rather than a line inside the send.

**Mode still falls back.** `Switch::Unsupported | Switch::Unknown` sends the spec's `Command::SetMode`, so an agent that does answer `session/set_mode` is served. Nothing measured so far does.

## Why it's this way

**Match on `category`, because the ids are the agent's own vocabulary.** OpenCode calls its selectors `model` and `mode`, which is tempting to match on and wrong to: `category` is the spec's word for what an option *is*. A test pins both directions - a renamed model selector is still found, and a *mode* selector that happens to be called `model` is not mistaken for a catalogue.

**Measured 2026-08-17, this stopped being a precaution.** Codex's effort selector has the id **`reasoning_effort`** under the category `thought_level`. OpenCode's ids happen to equal its categories, so id-matching works there and would have found no effort control on Codex at all. The same probe found four options where opencode sends two, the fourth being `collaboration_mode` (`default`, `plan`), categorized as itself.

**The v1 schema is asymmetric and it costs a compile cycle if you miss it.** An option *announcement* uses `id`, its entries use `value`, and the *request* uses `configId`. OpenCode sends `id`/`value`, which is v1-correct; reading it with the v2 types would fail to deserialise. Tori is on v1 throughout, so a future move to protocol v2 changes the wire, not just the types.

**Wiring modes through this was load-bearing rather than tidy, and the reason is a real safety hole.** Before phase 8, `set_mode` recorded a pending mode and sent `session/set_mode` into the void, so an ACP mode switch was a no-op. Measured: `codex-acp` **ignores the user's own `approval_policy` and `sandbox_mode`** from `~/.codex/config.toml` (verified via `config/read`: both set, the agent writes anyway) and applies its own `agent` mode, which approves edits inside *and outside* the workspace silently. So without this route, Codex's permission prompt was a capability [[concept_harness_capability_tiers]] published and no user could reach.

**Effort is a real ACP concept, against what the transport first asserted.** `ThoughtLevel` is its own category and `codex-acp` publishes six levels under it.

Tori used to publish only the five its `Effort` enum could carry and **dropped `ultra`**, because offering a level `set_model` had no way to send is the picker-that-appears-to-switch failure again. **That enum is gone and nothing is dropped now** (commit 8d67733): a level is a plain string, so it goes out exactly as the agent spelled it. The narrowing existed to protect a closed type, and with the type open there is nothing left for it to protect - filtering a published level against a list Tori keeps would be Tori deciding which of the agent's own words it approves of. Widening the enum instead would have moved one agent's vocabulary into a type two harnesses share, which is the trap `PermissionMode` already records; the day a third harness disagreed was the day it became a string.

**The option set follows the model, measured on both agents.** An agent publishes its options once, on `session/new`, which invites the assumption that the set describes the *session*. It describes the session's **current model**. Measured 2026-08-21 with `dev/acp-probe.mjs --per-model`, which switches model inside one session and diffs the answer:

| agent | model | `thought_level` choices |
| --- | --- | --- |
| `opencode acp` 1.18.3 | `claude-opus-4.5` | `max, high` |
| | `claude-opus-4.7` | `low, medium, high, xhigh, max` |
| `codex-acp` | `gpt-5.6-terra` | `low, medium, high, xhigh, max, ultra` |
| | `gpt-5.6-luna` | `low, medium, high, xhigh, max` |
| | `gpt-5.4-mini` | `low, medium, high, xhigh` |

Two consequences. **What varies is a bespoke category, not a mirrored one:** `mirroredOptions` drops `model`, `mode` and `thought_level`, so the control this moves is the *effort picker*, not [[concept_generic_config_mirror]]. And **a cache that copies one session's set onto every model row is wrong for all but one of them** - Tori did exactly that, so a draft on `gpt-5.4-mini` offered `ultra`, a level that model refuses. That is the offer-what-cannot-be-sent failure [[lesson_a_declared_catalogue_describes_someone_elses_machine]] retired the model tables for, reached from the other direction. [[component_catalog_probe]] now switches to each model and caches its own answer.

**A live list wins, and never merges.** `SessionStarted`/`SessionReady` carry `models` and `modes`, and `pickableModels`/`pickableModes` take the live list over the adapter's TOML table. So an ACP adapter declaring no models is not a gap: it is what makes the picker show the user's own. The catalogue is **per account** - OpenCode lists the providers that user has authenticated - which is why a bundled `[[chat.models]]` table would be a guess about somebody else's account.

## Related

- [[concept_generic_config_mirror]] — what happens to every option outside those three categories
- [[component_catalog_probe]] — which reads the same answer with no session to render it into
- [[component_acp_transport]] — where this is implemented
- [[concept_acp_agent_quirks]] — the wider measured-versus-spec list this belongs to
- [[concept_harness_capability_tiers]] — why a mode's danger is still not publishable
- [[component_chat_model_resolver]] — the live-wins-over-table rule on the model side
- [[lesson_probe_the_capability_before_building_its_control]] — the discipline this is an instance of
