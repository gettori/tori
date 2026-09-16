---
summary: a rejected credential flag was set by a 401 and cleared by nothing, so a state flag needs both edges and one owner
status: current
updated: 2026-08-03
source: "Editor Wave 3: GitHub as a first-class surface (personal/sway, branch `wave-3`); Phase 2 (a Phase 1 bug) and Phase 2 self-review; commits 474f146, e73cf00; `src-tauri/src/forge/http.rs`, `src-tauri/src/forge/auth.rs:158`"
---

# A health flag needs both edges and exactly one owner

## What happened

`Recording.suspect` (the flag saying "the credential was just rejected") was a **one-way latch**: a single 401 set it and nothing could clear it. A token that had been rejected once, then re-authorized, stayed marked bad for the life of the process. Self-review then found a second problem in the same area: a second copy of the flag lived elsewhere and the two were never connected, so one could say suspect while the other said fine.

## Why

Both failures come from the same mistake, which is thinking of a health flag as an *event record* ("a 401 happened") rather than as *current state* ("the credential is currently suspect"). An event record only ever needs a set, so the clear never gets written. And once it is treated as a record rather than as state, copying it somewhere convenient feels harmless, because a record of the past cannot go out of date, while a state absolutely can.

The distinction matters here more than usual: the correct response to a 401 is to **suspend, never destroy**. Deleting the keychain entry on a rejection would turn a transient server error into a forced re-authentication, so the flag is the only thing standing between a blip and a sign-out, and a flag that cannot clear makes the blip permanent anyway.

## What to do next time

For any flag that describes a current condition, write the clearing edge in the same commit as the setting edge, and give it exactly one owner that everything else reads. If a second component seems to need its own copy, it needs a reader instead. A useful check: ask what sequence of events returns the flag to false, and if there is no answer, it is a latch pretending to be a state.

## Related

- [[concept_forge_provider_seam]] - the transport wrapper that owns the flag
- [[component_forge_client]] - where a suspect credential pauses polling instead of signing out
- [[lesson_pure_core_for_global_stores]] - the one-owner discipline for global state
