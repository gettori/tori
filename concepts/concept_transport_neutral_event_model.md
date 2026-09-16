---
summary: one normalized ChatEvent enum hides every vendor's wire format, and a generated fixture pins both sides against drift
status: current
updated: 2026-09-04
source: "plan \"Native Claude chat as the default session surface\" (phases 1, 2, 3, 10, 12) and plan \"Make the session controls tell the truth about the CLI\" (phases 1, 4), branch `chat`; `src-tauri/src/chat/model.rs`; `src/utils/chatTypes.ts`; `src-tauri/src/chat/claude.rs`; `src-tauri/src/chat/neutrality_check.rs`; nested-field guard: plan \"Answer AskUserQuestion inside the chat panel\" (phase 2), branch `chat-transcription`, commit `e97d9a0`; subagent variants: plan \"Subagent lanes in the chat panel\" (phases 1, 2b), branch `bugfix-260903`, commits `f156dc9`, `4321b45`"
---

# The transport-neutral chat event model

One normalized `ChatEvent` enum is the only thing the UI ever sees. Claude's wire format is mapped into it by `claude.rs` and nothing above that module knows the vendor's frame names. The same enum is mirrored in TypeScript, and the two are kept honest by a **generated fixture** rather than by discipline: a Rust test serializes one sample per variant to `dev/fixtures/chat/events.json`, and the TS test parses that exact file. A renamed field fails on one side or the other instead of surviving as two halves that disagree.

## How it works

- **Rust is the source of truth.** `ChatEvent` (`model.rs`) is `#[serde(tag = "type", rename_all = "camelCase")]`. `every_event()` holds exactly one sample per variant, and two exhaustive `match`es (`model.rs`, `neutrality_check.rs`) plus a hard count assertion fail to compile or fail the test when a variant is added without a sample.
- **The fixture is the contract.** `emit_wire_samples_for_the_typescript_mirror` writes `events.json`; `src/utils/chatTypes.test.ts` reads it and checks the variant set, field names, and exhaustive narrowing against `CHAT_EVENT_KEYS`.
- **Harness specifics ride in `extra`.** Anything Claude-specific that is not worth a typed field (`skills`, `agents`, `plugins`, `capabilities`, `memory_paths`) is passed through untyped and narrowed at the edge by `chatCapabilities.ts`.
- **History replays as events, not as a second renderer.** `chat/history.rs` maps stored `TranscriptTurn`s onto the same events a live child emits, so [[component_chat_panel]]'s reducer folds live and replayed turns identically. A separate history renderer would be the one that rots.
- **The mapper is stateful on purpose.** `system/init` re-emits on *every* turn, so `ClaudeMapper` tracks `session_open` to make the first one a session start and every later one a turn start. Treating each as a session start would reset the transcript mid-chat.

## Why it's this way

A second harness (Codex, Gemini) should be a module plus a TOML table, not a rewrite. Keeping every vendor name below `claude.rs` is what makes that true, and the `match` over `ChatTransport` in `commands.rs` is exhaustive so a TOML naming a transport with no implementation is a build error rather than a runtime one.

The mirror is generated because hand-writing both sides is exactly how a mirror drifts silently. Both sides can be individually green while disagreeing on the wire; only a shared artefact catches that.

`extra` exists so the neutral model does not have to grow a field for every vendor curiosity. The cost is that its contents are `unknown` and must be narrowed defensively, which is why `stringList` drops entries it cannot read rather than rendering `[object Object]`.

## A neutral field is a value, not always a variant

`PermissionMode` used to be an enum of Claude's four modes, so a foreign vocabulary could not be expressed and drift showed up as a build error. It is now a `#[serde(transparent)]` newtype over `String`, because **Codex names its permission profiles at runtime** (`permissionProfile/list`) and no fixed set can represent that. Two consequences worth carrying:

- **The compile-time guard did not survive the change and had to be rebuilt as tests.** A string accepts every vocabulary by design, so nothing fails to compile when the guard goes missing. See [[gotcha_replacing_an_enum_with_a_string_silently_disarms_a_compile_time_check]] - the enum had already forced the ACP arm to record a Gemini mode under Claude's `AcceptEdits`, which is the exact substitution it existed to prevent.
- **An unknown value passes through rather than being folded.** `claude.rs::permission_mode` used to collapse anything unrecognised into `Default` - the strictest, which sounds safe and is backwards: a session really running `dontAsk` was reported as "asks before acting". Resolution now happens where it is decidable, at `ChatConfig::resolve_mode`; see [[concept_capability_resolution]].

`ChatAccount` (`subscriptionType`, `organization`, `apiProvider`) rides `SessionReady` and `SessionStarted` from the same handshake, as an `Option` rather than a struct of empty strings: "the handshake never answered" and "an account with no organization" are different facts and only one of them renders. `email` is deliberately dropped at the Rust boundary - nothing reads it, and an unread personal identifier only ever leaks.

## The mirror check has a blind spot, and it is now covered

`CHAT_EVENT_KEYS` compares an event's **top-level** field names only. A rename *inside* a nested struct (`ChatAccount.subscriptionType` -> `plan`) passes it untouched, because the nested object is one key either way. `ChatAccount` handles this with hand-written field reads in the exhaustive-narrowing test; verified by regressing the Rust side with `#[serde(rename)]` and watching the TS test fail.

`QuestionRequest` made that ad-hoc treatment durable, because it carries three nested structs at once. `CHAT_NESTED_KEYS` in `chatTypes.ts` enumerates every nested field name through `keysOf<T>(shape: Record<keyof T, true>)`, which bites in **both** directions: a rename on the Rust side fails the fixture comparison, and a rename on the TypeScript side fails `tsc` through the `Record<keyof T, true>` argument. Verified by mutation rather than by assertion, all ten nested names renamed one at a time in Rust's own fixture output, all ten failing. Any future nested payload goes in that table rather than growing another set of hand-written reads.

## A lane rides beside the event, not on it

Three variants carry a subagent: `SubagentStarted` (the only frame joining its two ids), `SubagentUpdate` (one variant for three frames that patch one record, every field optional because each sends a different subset), and `SubagentCall`.

`SubagentCall { agent_id, tool_use_id }` is the interesting one, because the obvious design was a field. Adding `agent_id` to the item-opening variants (`ToolCallStarted`, `ToolCallCompleted`, `FileEdit`, `UserMessage`) means naming it at ninety-odd construction sites across ten files, nearly all of which would say `None` forever because ACP has no subagents. Emitting it **beside** the call instead, from `map`, keys on the id the store already uses to reconcile a permission prompt with its assistant frame, and costs one arm.

The two deltas are the exception and were the second phase's whole subject. `TextDelta` and `ThinkingDelta` **do** carry `agent_id`, because a subagent does not stream, so its one whole `assistant` frame has no delta twin to inherit a lane from. Both fields are `#[serde(default)]`, so an event serialized before they existed reads back as the main agent's rather than failing to parse.

`SubagentStarted` also carries `task_type`, which is the neutral model's one admission that this channel is wider than the variant's name: `local_agent` is a subagent and `local_bash` is a backgrounded shell command, folded into one variant because the wire is one channel and the same three frames patch either record.

`SubagentUpdate::status` is a plain `String` and never an enum, per [[gotcha_replacing_an_enum_with_a_string_silently_disarms_a_compile_time_check]]: an unrecognised status has to reach the UI as itself. See [[concept_subagent_lanes]].

## Related

- [[component_chat_host]] - the Rust modules that produce these events
- [[concept_subagent_lanes]] - what the three subagent variants are folded into
- [[component_chat_panel]] - the reducer that folds them
- [[component_agent_adapter_registry]] - the schema v2 `[chat]` table declaring the transport
- [[lesson_pin_a_vocabulary_not_a_sequence]] - how the wire format itself is pinned
- [[adr_native_chat_surface]] - why the model is neutral at all
- [[concept_inline_agent_question]] - the event and command that forced the nested guard
- [[concept_capability_resolution]] - how a mode string is resolved against what a harness and model actually support
- [[lesson_a_check_that_builds_its_own_expected_event_checks_nothing]] - the neutrality check asserted a mapping the real mapper never made, and how the table now names a drop instead
