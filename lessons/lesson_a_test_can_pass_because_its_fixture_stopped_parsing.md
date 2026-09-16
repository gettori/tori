---
summary: deleting a parser can leave old fixtures unparseable, a test asserting a value keeps passing for the wrong reason
status: current
updated: 2026-07-31
source: Session navigation moves to a History dropdown; pi and opencode are removed (branch `navigation`, phase 8); `src-tauri/src/sessions.rs` `gate_tail`; commit e6d98c2
---

# A test can pass because its fixture stopped parsing

## What happened

Phase 8 deleted the pi transcript parser. A test named `session_tail_state_pi_pending_tool_use_is_capability_gated_to_working` kept passing, and was nearly left alone on that basis. It was asserting that a pi session with a pending tool call collapses to `working` because pi's `needs_you` capability is off. Both halves of that had stopped being true: `agents::find("pi")` now returns `None`, which defaults `needs_you_capable` to **true**, so the gate no longer fired at all. The test still passed only because its pi-shaped fixture no longer parsed, the turn list came back empty, and an empty tail classifies as `working` by coincidence.

## Why

A test that asserts a *value* rather than a *mechanism* has two ways to be green, and deleting code can silently move it from one to the other. Here the expected value (`Working`) was reachable both through the gate under test and through "there is nothing to classify". Once the fixture stopped parsing, the second path took over and the assertion carried on agreeing.

Deletion work is where this is most dangerous, because the whole activity is removing the code paths tests were written against. A green suite after a large deletion is weaker evidence than a green suite after a change.

## What to do next time

**After deleting a parser, format, or adapter, grep the test suite for fixtures written in that format and read every test that still passes.** A test whose fixture is now unparseable is not covering anything, and it will keep saying so.

When the deleted thing was the only subject a capability test had, **extract the mechanism into a pure function and test it directly** rather than deleting the test. `gate_tail(tail, needs_you_capable)` reads the registry nowhere, so the off case is reachable from a unit test even though no bundled adapter turns the capability off any more. The gate survives for user adapters; without the extraction its coverage would have gone with pi.

## Related

- [[concept_needs_you_floor]] — the gate this concerns
- [[component_agent_adapter_registry]] — where `needs_you` is declared
- [[lesson_synthetic_test_values_hide_unit_bugs]] — the neighbouring failure, an assertion agreeing for the wrong reason

## Another instance: a mock naming an export that no longer exists (2026-08-03)

Editor wave 4 Phase 2 (branch `wave-4`, commit 0802a17) rewrote `lspClient.ts` and renamed `ensureLsp` to `ensureLspFor`. Four test files (`syntheticTab`, `blameToggle`, `conflictBanner`, `editorCommands`) `vi.mock` that module to keep CodeMirror out of jsdom, and each stubbed the old name.

Every project-switch effect then threw inside a promise. Vitest logged **8 unhandled rejections** and printed "this might cause false positive tests" — and reported **all 1510 tests passing**. The suite was green while four files exercised nothing.

Same shape as the original: a fixture stopped meaning what it says, and the runner's summary line cannot tell you. Two habits that catch it, neither of which the tooling does for you:

- **Read the unhandled-rejection count, not just the pass count.** It is printed above the summary and it is the only signal here.
- **`pnpm test` does not typecheck.** Run `tsc --noEmit` alongside it at every phase — it caught a bad cast in this same wave that the green suite did not.
