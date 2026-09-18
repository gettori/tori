---
summary: swapping an enum for a string to support foreign vocabularies removes a compile time guard, a string accepts anything
status: current
updated: 2026-07-29
source: Make the session controls tell the truth about the CLI, phase 1 (personal/tori, branch `chat`); `src-tauri/src/chat/neutrality_check.rs:542` (`a_foreign_mode_vocabulary_survives_the_model_unchanged`), `src-tauri/src/agents.rs:1346` (`every_declared_mode_is_one_the_cli_accepts`); [[concept_transport_neutral_event_model]]
---

# Replacing an enum with a string silently disarms a compile-time check

Do NOT assume a neutrality or exhaustiveness guard survives the type change that motivated it. `PermissionMode` was an enum precisely so a harness whose modes were not Claude's four could not be expressed: drift showed up as a build error. Turning it into a newtype over `String` is the right call (Codex names its permission profiles at runtime, so no fixed enum can represent it), but a string accepts every vocabulary by design, so **nothing fails to compile when the guard goes missing** - compiling is exactly what a string guarantees. The check has to be re-established as a test that asserts what a string cannot: that a foreign id reaches the far side *unchanged*, across serde too. Use a near-miss as the fixture (Gemini's `auto_edit` against Claude's `acceptEdits`), because a mapper quietly folding one into the other still passes a test that only checks "some mode came out". The enum had already caused that exact substitution: the ACP arm of the neutrality mapper recorded a Gemini mode change under Claude's `AcceptEdits`, since that was the only word the model had. Separately, the guard the enum *did* provide (an id nobody accepts cannot be written down) does not move to the type at all - it moves to a probe against the real binary, because a load-time check over adapter-declared ids cannot fail: every id in the TOML is "known" by construction.
