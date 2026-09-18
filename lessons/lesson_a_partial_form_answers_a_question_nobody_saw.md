---
summary: claim a form only after the whole payload parses, since recognising it by tool name alone can render an empty question
status: current
updated: 2026-08-22
source: plan "Answer AskUserQuestion inside the chat panel" (phases 3, 4), branch `chat-transcription`; `src-tauri/src/chat/claude.rs`; `src/panels/Chat/chatStore.ts`; commits `75853fb`, `ad266b5`
---

# Parse a form all or nothing, or it answers a question nobody saw

## What happened

`AskUserQuestion` arrives as a JSON blob and Tori renders it as a form. The first cut of the store claimed the call **as soon as the tool name matched**, so an input it could not read became an empty question row instead of falling back to an ordinary tool card. A test written to pin the broken-input case is what caught it, on my own code, after the Rust side had already got the rule right.

## Why

The answer string names every question it was handed. A form that rendered three of four rows would send an answer for four, and the missing one would be answered by whatever the user did with the rest. The agent would then act on a decision nobody made, and there is no frame anywhere that says a question was dropped.

So "readable" is not a property of the tool name, it is a property of the payload, and the two are checked in the wrong order the moment recognition is keyed on the name. `map_control_request` had it right (parse, then claim, all four questions or none, with five broken shapes pinned plus the one-bad-question-out-of-two case). The store had it backwards and looked identical from the outside.

## What to do next time

**Key recognition on the successful parse, never on the identifier that suggests the parse will succeed.** If a surface takes over the rendering of something, the takeover and the parse are one decision: claim it only after you hold the whole structure, and let anything short of that fall through to the generic path that was already correct.

**Write the malformed-input test even when the mapper upstream already has one.** The two layers make the same decision independently, and the second one is where nobody looks, because the first one's tests are green and the shapes are identical.

## Related

- [[concept_inline_agent_question]] - the mechanism, and where the rule is enforced twice
- [[component_chat_panel]] - the store that got it backwards first
- [[adr_askuserquestion_answer_channel]] - the answer string that makes a partial form dangerous rather than merely wrong
