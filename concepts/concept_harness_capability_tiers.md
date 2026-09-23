---
summary: harness capability tiers key on transport not agent id, with outcomes like rewind is fork; an unshipped one is omitted
status: current
updated: 2026-09-04
source: "\"Defer permissions to the harness, and grow to four harnesses\" (phases 2, 6 and 8, branch `chat-fix`); originally Chat surface plan, phase 11 (branch `chat`); `src/utils/chatCapabilities.ts` (`TIERS:145`, `publishedCapabilities`); `src-tauri/src/chat/neutrality_check.rs`; `subagents`: \"Subagent lanes in the chat panel\" (phase 6), branch `bugfix-260903`, commit `b58191b`"
---

# Harness capability tiers

What a given harness can actually do, declared once and read by every feature that depends on it. The values are **measured outcomes**, not feature names: the rewind tier is `fork` and the steer tier is `consumed-before-next-tool`, because a declaration reading `rewind: yes` would promise a second adapter's user something Tori measured against one CLI version only.

The file is `src/utils/chatCapabilities.ts`. It was `tiers.ts`, and it now holds both kinds of capability - what a *session* loaded (skills, subagents, plugins, off `system/init`) and what the *harness* supports - because both answer "what can this chat actually do".

## How it works

**Keyed on the transport, not the agent id.** `TIERS` is a `Record<ChatTransport, ChatTier>`: a user adapter pointing at `claude_stream_json` gets the same tier for the same reason it gets the same protocol, and a *new* transport fails to compile until someone states its tier. That exhaustiveness is the only thing stopping a second harness from inheriting Claude's measurements by silence.

**The tier is a floor, and the agent's handshake is the rest.** One generic ACP transport sits behind every ACP agent, so `TIERS.acp` states what **no** ACP session can do whichever agent is behind it, while `ChatCapabilities` from `initialize` states what *this* agent claims, and `publishedCapabilities(tier, live)` folds them. Without that split one transport would publish one answer for every agent behind it, which is the whole failure a per-transport tier was supposed to avoid once the transport stopped being one vendor's.

**A capability that did not ship is omitted, not published as `none`.** A listing is a promise, and an entry reading `rewind: none` invites reading the key and skipping the value.

**Omission alone was not honest enough, so `gaps` states the reason.** Omitting leaves a user with a control that is simply not there and nothing to read. Each gap's sentence is authored beside the values rather than derived from them, because two transports can lack the same thing for different reasons. A test requires every gap to carry one, which is what stops a new transport lacking something silently.

**What was one flag is now three keys, and a fourth question stopped existing.** `hooks` was a single boolean on the honest grounds that per-tool approval, Tori-owned rules, spend ceilings and before-state diffs all rode the one `PreToolUse` bridge. They no longer do:

- `approvals: "none" | "tori-hook" | "in-protocol"` - who asks the user before a tool runs. Under `in-protocol` the harness's own permission modes are the ones in force, so a mode named after bypassing permissions really does bypass them.
- `diffs: "none" | "agent-supplied" | "before-state"` - where a tool card's before-and-after comes from. Not a boolean; see below.
- `spendCeilings: boolean` - needs nothing from the harness, because it is Tori declining to open the next turn ([[concept_spend_ceilings]]).
- `toriRules` **is deleted**. No harness has a Tori-owned rule store to publish, so there is no longer a question to ask.

**`subagents` is three-valued because two different promises hide behind one flag.** `"none" | "observable" | "addressable"`, and the distinction is **addressability**, not attribution. `observable` is a lane per subagent you can read, live and again after reopening; `addressable` would add a channel to one, which nothing offers, because only the main agent can message a helper it launched. A boolean would have shipped the first while a user read it as the second, which is how a composer comes to look like it is talking to something it cannot reach. `claude_stream_json` is `observable`, `acp` is `none`, and a test holds `addressable` unclaimed until something earns it. See [[concept_subagent_lanes]].

The ACP gap names the protocol's silence and not Claude's hook, which is the wrong reason the `budgets` gap was already corrected away from: an ACP agent may well fan out, but nothing in the protocol announces one starting, working or finishing, so its nested calls arrive as the session's own and the transcript reads as one agent doing everything.

**`diffs` is three-valued because the boolean was measurably wrong in both directions.** It read `false` for ACP on the reasoning that an exact diff rides the Claude-only capture hook. Measured 2026-08-14, `@agentclientprotocol/codex-acp` 1.2.0 sends a `tool_call` content block carrying `oldText`, `newText` and the path - the same before-state the hook produces, and arguably a better one, since it is what the agent is *about to write* rather than what happened to be on disk when a helper got there. But `opencode acp` 1.18.3 sends none, so `true` would have been as wrong as `false` was. The value names which of the two Tori gets, which is the thing a user's expectation actually turns on.

**The gates, and what each was hiding.** `canSteer` requires `steer === "consumed-before-next-tool"`, because a harness that buffers to turn end would accept the write and deliver it as the *next* turn, which the user could not tell apart from a steer that landed. `rewindTsFor` requires `rewind === "fork"`, since a harness that cannot fork would promise the tree and the conversation and deliver only the tree.

**The command side of neutrality is a different question from the event side.** An event Tori cannot map is a gap in the model; a verb a harness cannot serve is normal and permanent. What would be wrong is a verb only Claude can be *asked* for, since then `AgentTransport` is Claude's interface wearing a neutral name. So `neutrality_check.rs` carries `Support` plus exhaustive `codex_support` / `acp_support`, and `every_command_is_answerable_by_a_harness_that_is_not_claude` pins both that `Steer` is refusable by both and that send / interrupt / close stay the shared floor, since a trait every verb may refuse describes nothing.

**A capability that is only partly supported cannot be one key.** `everyGapIsExplained` has a sibling check forbidding a key from being both published and explained in `gaps`, which is exactly what a half-supported feature wants to be. Attachments split into `attachmentMentions` (a path the agent already has) and `attachmentUploads` (bytes Tori writes under its own folder), because ACP carries a path as text today and has no measured way to read app data: one key would have had to lie in one direction or the other. Splitting is the general answer, not a special case for attachments. See [[concept_labelled_attachments]].

## Why it's this way

The declaration has to read something real rather than be maintained by hand. `AgentTransport::steer` documents that a harness buffering stdin to turn end must return an error rather than degrade into a queued turn, and `steerable` is the single frontend predicate. The risk to guard against is the two drifting apart.

**Two things a live handshake must not be allowed to promise.** Session fork is advertised by both probed ACP agents and is still published as unavailable, because Tori's rewind is a fork plus a tree snapshot and the ACP transport implements no fork verb: publishing the agent's advertisement would offer a rewind that fails when clicked. And a permission mode's *danger* is not on the wire at all - an agent publishes an id, a label and a description, so `permissive` and `default` are left undeclared on a live ACP mode. Codex's `agent-full-access` really does run tools unattended and nothing in the protocol says so; inferring it from the words in an id is the per-vendor knowledge a generic client must not carry. That is a real gap, recorded rather than papered over.

**One thing recorded rather than fixed.** A spend ceiling set against a harness that reports no cost is silently not armed. Returning early is right, but the user is told nothing, and the ceiling rows live in global Settings where a per-agent explanation has no obvious home.

## Related

- [[concept_transport_neutral_event_model]] - the event half of the same discipline
- [[concept_acp_agent_quirks]] - where the per-agent variance behind the ACP floor is recorded
- [[concept_blocking_tool_call_ceiling]] - the measured per-harness limit on a blocking MCP call
- [[concept_rewind_by_fork]] - the measured value behind `rewind: fork`
- [[concept_mid_turn_steer]] - the measured value behind the steer tier
- [[concept_spend_ceilings]] - why ACP publishes `false`, and it is not the hook
- [[concept_subagent_lanes]] - the measured value behind `subagents: observable`
- [[concept_labelled_attachments]] - why `attachmentMentions` and `attachmentUploads` are two keys
- [[concept_pretooluse_capture_hook]] - what `diffs: before-state` reads from
- [[component_agent_adapter_registry]] - where a user adapter names its transport
- [[lesson_fix_the_kill_threshold_before_measuring]] - where the published values came from
