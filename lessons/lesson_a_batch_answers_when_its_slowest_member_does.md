---
summary: a batch resolving only when its slowest member does holds the UI empty on one stuck probe, fan out per-element instead
status: current
updated: 2026-08-17
source: plan "Model catalogues from the harnesses themselves" (phases 1 and 4, branch `settings-and-chat`); `src/utils/modelCatalog.ts` (`refreshDueCatalogs`, `refreshCatalogIfDue`); the deleted `catalog_probe::refresh_model_catalogs`; commit "Show the models a harness actually named"
---

# A batch answers when its slowest member does

Phase 1 shipped three Tauri commands, one of which swept every due harness on its own threads and returned the lot: `refresh_model_catalogs()`. It was correct, concurrent, and the wrong shape for a UI. Phase 4 deleted it before anything rendered from it.

## The arithmetic

Each probe spawns a real agent. The deadline is 45s. A batch resolves once, when its slowest member does, so **one agent hitting that deadline holds every card on the page empty for the whole 45 seconds** - including the four that answered in a second. A refusal becomes everyone's wait rather than one row's error.

Fanned out, the same work has the same total cost and a completely different feel: each card fills as its own probe lands, and a signed-out harness shows "Error" while its neighbours show their lists. The per-harness lock meant nothing was lost in concurrency either; the backend was already safe to call this way.

## What deleting it cost, and why that was fine too

`ModelCatalog::is_stale` in Rust had exactly one caller: the batch command. Rather than keep it for symmetry it was deleted, leaving one implementation of the staleness rule, in `modelCatalog.ts`, beside the code that acts on it. Two languages implementing one rule is two things to keep in step and no reader to notice when they drift. The rejected-TTL rationale stayed behind as a comment on the field, and the three Rust tests moved to the TS file unchanged in substance.

## The general shape

A batch endpoint is the right API when the caller needs the whole result together - a dedup across every finding, a "zero results, skip the next stage" decision. It is the wrong one when each element has an independent consumer on screen. **Ask who is waiting.** If the answer is "one row per element", the aggregate is a coupling nobody asked for, and the fan-out belongs in the caller where the concurrency limit and the per-element error state already live.

The same reasoning ran once more, in the other direction, later in the same phase: opening a chat asks **only its own harness**, not every due one. Opening a claude chat is already launching claude, so asking it costs nothing new; sweeping would spawn every other agent on the machine because a chat was opened.

Related: [[component_catalog_probe]], [[concept_no_turn_probe]], [[gotcha_a_cached_promises_value_is_the_state_of_the_world_at_first_load]].
