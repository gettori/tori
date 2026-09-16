---
summary: every ACP option Sway never saw crosses the wire and renders by shape rather than dropped, republished on any change
status: current
updated: 2026-08-17
source: plan "Model catalogues from the harnesses themselves" (phases 5 and 6, branch `settings-and-chat`); `src/panels/Chat/ConfigMirror.tsx`; `src/utils/chatTypes.ts` (`ChatConfigOption`, `mirroredOptions`); `src-tauri/src/chat/acp.rs` (`config_options`); `src-tauri/src/chat/model.rs` (`ChatConfigOption`, `ChatEvent::ConfigOptions`); measured against `@agentclientprotocol/codex-acp` 1.2.0
---

# Mirroring a control Sway has never seen

An ACP agent publishes its configuration options on `session/new`. Sway used to read three of them (model, mode, thinking level) and drop the rest, which meant anything else the agent offered was unreachable with nothing saying so. The mirror is the inversion: **everything crosses, and the surface decides what already has a control of its own.**

This is not hypothetical breadth. Measured on Codex: four options, and the fourth is `collaboration_mode` (`default`, `plan`) - Codex's plan mode, categorized as itself, claimed by no bespoke control. Before the mirror, Sway read it off the wire and threw it away.

## The shape

`ChatConfigOption` is a neutral type in `chat/model.rs`, beside `ChatModelInfo`, not a re-export of the protocol struct: sending `SessionConfigOption` to the frontend would put one protocol's schema in the model that [[concept_transport_neutral_event_model]] exists to keep neutral.

- `id`, `name`, `description` - the agent's own words, rendered verbatim. Sway has no better word for a lever it has never seen.
- `category` - **a string, not an enum**, and empty means the agent published none. The spec's category enum is `#[non_exhaustive]` with an `Other(String)`, and the uncategorized case is exactly the row no bespoke control claims, so normalising it away drops the rows this type exists for. A future variant this build cannot name also reads as empty, which sends it to the generic renderer rather than to a control written for a different lever.
- `kind` - `select { current, choices }` or `boolean { value }`, flattened onto the object so a renderer switches on one discriminator.

Rendering is **by shape, not by name**: a select becomes the same menu pill the model picker is, a boolean becomes the same switch Settings uses. A kind this build cannot draw is **skipped and logged**, never rendered as a dead widget - both `SessionConfigKind` and the TS mirror have to survive a build older than the agent it is talking to.

## Always the whole set, never a delta

`ChatEvent::ConfigOptions` carries the agent's entire option list every time, and the store replaces rather than merges. It fires three times over a session's life: behind `SessionStarted`, from `session/update`'s `ConfigOptionUpdate` (which nothing handled before), and from every `set_config_option` answer.

The reason is that **one option can re-cut another's choices**: picking a model changes which thinking levels exist. A mirror patched per option would go on offering a choice the agent had just withdrawn.

That is also why the event is its own variant rather than a field on `SessionStarted`: the interesting half is the re-render, and `SessionStarted` fires once.

## The filter is at the surface, not at the source

`mirroredOptions` (in `chatTypes.ts`, so the chat mirror and the Settings preview share one answer) drops `model`, `mode` and `thought_level`. Everything else renders. The cache and the event still carry all of it, because filtering earlier would make the cache the place a new option gets lost.

The reason the three are excluded is not tidiness: a mirrored copy of the model picker would be a second control writing one piece of session state, which is how two controls end up disagreeing about what the session is running.

## Sending one back

`chat_set_config_option(sessionId, configId, value)` -> `AgentTransport::set_config_option`. A harness that publishes no options **errors** rather than succeeding silently; nothing can reach it without a mirror to click in, so a quiet `Ok(())` would only ever hide a routing bug (claude's arm says exactly that).

Two details that bite:

- **A toggle travels as a boolean and a choice as a value id.** Sending the string `"true"` for a toggle is a value id, and an agent given the wrong shape either refuses or silently does nothing. `option_value` exists so that mapping is a test rather than a line inside an async loop.
- **The readback follows the id, not the category.** The three bespoke selectors are found by category; a mirrored option is by definition the one no category claims, so reading one back through a category lookup compares an unrelated selector and reports a mismatch on every switch.

## No pending state, unlike a mode

A mode waits for a turn boundary because it decides whether the agent asks before it writes. A mirrored switch goes out immediately: Sway does not know what the lever governs, so holding it back would be Sway inventing next-turn semantics for an option it has never seen. Nothing moves optimistically either - the control renders what the agent last published, so a refused switch leaves it showing what is actually in force.

## Related

- [[concept_acp_config_options]] — the protocol mechanics underneath
- [[component_catalog_probe]] — where the same shape is cached for the Settings preview
- [[component_acp_transport]] — the transport that emits and forwards these
- [[concept_transport_neutral_event_model]] — why this is a neutral type rather than the protocol's
- [[concept_capability_resolution]] — the bespoke half of the same story
