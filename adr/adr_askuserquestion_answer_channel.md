---
summary: answers AskUserQuestion by denying the tool call with the synthesized answer in the deny message field
status: current
updated: 2026-08-22
source: plan "Answer AskUserQuestion inside the chat panel" (phases 0, 3), branch `chat-transcription`; `dev/protocol-probe.mjs` scenario `ask-user-question`; `src-tauri/src/chat/claude_transport.rs:365`
---

# A question is answered in protocol, by denying the tool call with the answer as the message

`AskUserQuestion` is not a permission question, but it arrives on the same wire as one, and a permission answer has exactly one field that carries text to the model: a deny's `message`. So Tori answers a question by denying the call and putting the synthesized answer string in the denial. Measured on claude 2.1.239: the message reaches the model byte for byte, non-ASCII included, about 3ms later, and 20 of 20 runs across Opus and Sonnet acted on the answer without re-asking, despite the tool result carrying `is_error: true` where a real client's answer carries `false`.

## Considered Options

**A dedicated `AskUserQuestion`-matched `PreToolUse` hook**, emitting `permissionDecision: "deny"` with the answer as `permissionDecisionReason`. Rejected, and never measured, deliberately. Its only two advantages over the in-protocol route were mode coverage and owning the clock, and the in-protocol route has both:

- `AskUserQuestion` raises `can_use_tool` in **all four** permission modes, 5 runs each, 20 of 20, `bypassPermissions` included. That is a real exception to what [[component_chat_host]]'s `map_control_request` measured for every other tool, and the reason is structural: the CLI has no interactive client on this transport, so it hands the question out rather than deciding it.
- There is **no CLI deadline** to fit inside. An unanswered question was still outstanding after 417 seconds with zero frames emitted after the ask, matching what [[concept_pretooluse_capture_hook]] already records for permission questions generally.

Building the hook would have meant a second settings entry, a second helper mode, and a helper that blocks indefinitely, to buy nothing.

## Consequences

**This does not reopen `tori-harness-owns-permissions`.** Tori is not deciding a permission here; it is carrying a person's answer through the only field the protocol gives it. The capture hook stays decision free, and no `permissionDecision` is introduced anywhere. See [[adr_harness_breadth]].

**A question needs no deadline, and gets none.** `arm_auto_deny` is not armed for a question. Since the CLI will wait indefinitely, the only thing that must never be skipped is cancellation: closing the tab, ending the session or interrupting the turn has to answer or withdraw the question, because nothing else ever will.

**Two things that look like a Tori bug and are not.** Allowing the call makes the CLI self-answer within milliseconds with `The user did not answer the questions.`, because allowing runs it against a client that is not there; that string is the CLI's, not Tori's, and it is what an earlier investigation mistook for a 60s park. The `No response after 60s` string belongs to the interactive TUI, which has a timer this transport does not.

**The answer strings are a measurement, not a convention**, in the same sense as everything else below `claude.rs`. Three details that a reading of the transcripts corrected: the "user answered" phrasing is used only when an answer contains free text (a `multiSelect` with several picks stays on the "questions have been answered" phrasing, joined with `, ` inside one value); that string and the TUI timeout string carry U+2014, not a hyphen; and an option may declare a `preview`, which the answer echoes back as ` selected preview:` plus the preview text.

## Amendment (2026-08-22, what building it settled)

The ADR was written from the spike, before the plumbing existed. Four things the build fixed in place:

- **There is no timer to disarm, because none is created.** `arm_auto_deny` became `park(..., after: Option<Duration>)`, and a question passes `None`. Nothing is spawned, so nothing can expire.
- **Cancellation is asymmetric, and that asymmetry is new.** Tab close and session end deny every outstanding request; an **interrupt withdraws only questions**, because a permission still has a deadline that will settle it. `Shared::pending` became a kind-carrying map to make that expressible.
- **An unreadable question degrades to a permission prompt, never to a partial form.** The answer string names every question it was given, so a form one row short would answer a question the user never saw. Both the mapper and the store parse before claiming. See [[lesson_a_partial_form_answers_a_question_nobody_saw]].
- **Picks and free text join into one value**, which is an extension of the measured grammar rather than a measurement: the corpus has no entry carrying both, because the CLI's own client cannot produce one, while Tori's form offers Other beside a multi-select's boxes.

The em dashes are written `\u{2014}` in the Rust source, so the file stays ASCII while the byte on the wire does not, with a test asserting exactly two and no ` - `. The kill switch is `chatDefaults.answerQuestionsInline`, defaulting on through `#[serde(default = "yes")]` so a settings file predating the feature does not read as off.

The machinery is [[concept_inline_agent_question]].

## Related

- [[adr_native_chat_surface]] - the surface this question form lives in
- [[adr_harness_breadth]] - the decision that retired Tori-owned permissions, which this deliberately does not undo
- [[concept_pretooluse_capture_hook]] - the hook that stays decision free, and the rejected alternative's machinery
- [[component_chat_host]] - `map_control_request` and the permission answer path this rides
- [[concept_transport_neutral_event_model]] - where the question's own event variant lands
- [[concept_inline_agent_question]] - the machinery either side of this channel
- [[gotcha_allowing_an_askuserquestion_makes_the_cli_answer_it_itself]] - the one-line form of the trap
