---
summary: AskUserQuestion is recognized all or nothing and answered with a measured string built from real tool results
status: current
updated: 2026-08-22
source: plan "Answer AskUserQuestion inside the chat panel" (phases 2, 3, 4), branch `chat-transcription`; commits `e97d9a0`, `75853fb`, `ad266b5`
---

# An agent's question, answered in the transcript

**Location:** `src-tauri/src/chat/claude.rs` (recognition + the answer strings), `src-tauri/src/chat/claude_transport.rs` (parking and withdrawal), `src/panels/Chat/chatStore.ts` (the item kind), `src/panels/Chat/QuestionCard.tsx` (the form)

`AskUserQuestion` reaches Sway as a `can_use_tool` control request, because the CLI has no interactive client on this transport and hands the question out rather than deciding it. Sway renders it as a form in the transcript, and the answer travels back as the one field a permission answer has for text: a denial's `message`. The channel itself is [[adr_askuserquestion_answer_channel]]; this page is the machinery either side of it.

## The question is its own event, not a permission

`ChatEvent::QuestionRequest { session_id, tool_use_id, request_id, agent_id, questions }` and `ChatCommand::RespondQuestion` are variants of their own on [[concept_transport_neutral_event_model]], events 20 to 21 and commands 8 to 9. That is what keeps the vendor's answer wording inside `claude.rs`: nothing above it knows the answer is a denial, or what the string says. It is also the shape a later ACP `elicitation/create` maps into, which is why the ACP transport's `respond_question` refuses with an `Err` rather than a silent `Ok(true)`.

The event carries **no `turn_id` and no deadline field**. A question blocks a tool call, not a turn frame, which is why `PermissionRequest` is session scoped too, and there is no clock to model.

## Recognition is all or nothing

`map_control_request` claims the call only when `parse_questions` reads the whole form. A partly readable input falls back to an ordinary permission prompt, and the same rule is repeated in the store: `toolCallStarted` parses **before** it decides to suppress the tool card. The answer string names every question it was handed, so a form one row short would put an answer in front of the agent for a question the user never saw. See [[lesson_a_partial_form_answers_a_question_nobody_saw]].

## The answer string is measured, not invented

`answer_message` builds one of two shapes from 411 real tool results:

- Every value made of declared option labels: `Your questions have been answered: <entries>. You can now continue with these answers in mind.` A multi-select with several picks stays here, joined with `, ` inside one quoted value.
- At least one value that is free text: the `The user answered:` phrasing, which asks the model to read the answers as possibly a refusal or a correction. One free-text answer moves the whole call onto it.

One entry is `"<question text>"="<value>"`, joined by `, `, with ` selected preview:` plus the option's own preview text appended when the picked option declared one. Two details that a careful reading of the corpus corrected and a casual one gets wrong: the second string carries **U+2014**, not a hyphen (written `\u{2014}` in the Rust source, with a test asserting exactly two of them and no ` - `), and an option may carry a `preview` key that the answer echoes back.

**Picks and free text join into one value, and that is an extension rather than a measurement.** The corpus has no entry carrying both, because the CLI's own client cannot produce one, but Sway's form offers Other beside a multi-select's boxes. One value per question is the only shape the grammar has, so they join with `, `. A test pins it so the choice is on the record.

A blank Other box is not free text. Without the trim and filter, an empty field left behind by the form would move the whole call onto the free-text string and tell the agent to read a clarification nobody wrote.

## Nothing expires, so cancellation is the only exit

`park(shared, id, kind, after)` replaced a fixed `arm_auto_deny`: a permission passes `Some(110s)`, a question passes `None` and no thread is spawned at all. `Shared::pending` had to stop being a `HashSet<String>` and become a `HashMap<String, Parked>` for one reason: the three exit paths are not symmetric. Tab close and session end deny everything, but an **interrupt withdraws only questions**, because a permission still has a deadline that will settle it and a question has none. An interrupt is the only thing standing between an abandoned turn and a child blocked for the life of the process.

`parked_questions` remembers each outstanding form so the answer can quote the question and echo its preview. It is dropped on claim and cleared on every exit path including EOF, which the self review caught it not doing while a comment claimed otherwise.

## The tool card gets out of the way at both ends

The store suppresses `AskUserQuestion` at `toolCallStarted` **and** at `toolCallCompleted`, because `ensureTool` creates on miss: the completion alone would resurrect the card the declaration refused to make, carrying the answer string as a denied call. That is the failure the whole item exists to prevent.

`ensureQuestion` also **adopts a tool card that already exists for the id**, in place rather than by splicing, since both indexes are positions into `items`. The window is real: the backend reads `answerQuestionsInline` when it spawns and the store reads it when it mounts, so flipping the setting and then switching tabs (which rewires rather than respawns) leaves a store that suppresses nothing talking to a child that still asks.

## A replayed question is read only by construction

`history.rs` emits no `questionRequest`, so a rebuilt row has a null `requestId` and there is nothing to answer. That is the whole mechanism, rather than a second flag that could disagree with it. The row is assembled from the tool call's own input and its result, which is a real seam: the replayed card is built differently from the live one.

It **quotes the agent's record verbatim and does not parse it back** into per-question picks. The rejected alternative was an inverse of the entry grammar anchored on the known question prose, which would work most of the time; a value can carry the user's own words, quote characters included, and a card guessing wrong about what was chosen is worse than one quoting the record.

## Watch out

- The kill switch is `chatDefaults.answerQuestionsInline`, read once at spawn. `#[serde(default = "yes")]` rather than a bare default, so a settings file written before the feature reads as on instead of silently disabling it.
- If the IPC call fails after Submit the card stays settled and the user cannot retry. That matches the permission path exactly, and diverging here would make the question the odd one out.

## Related

- [[adr_askuserquestion_answer_channel]] - why the answer is a denial, and what the hook route would have bought
- [[concept_transport_neutral_event_model]] - the event and command this added, and the nested-field guard it forced
- [[component_chat_host]] - the parking, the withdrawal and the transport seam
- [[component_chat_panel]] - the item kind and the card
- [[component_radio_group]] - the controls the form is built from
- [[lesson_a_partial_form_answers_a_question_nobody_saw]] - the all-or-nothing rule, and where it was first missed
