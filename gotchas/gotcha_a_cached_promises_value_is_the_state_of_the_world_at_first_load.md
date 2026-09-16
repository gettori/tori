---
summary: a latched cached promise's value is the answer at first load, await it for ordering but read the signal for now
status: current
updated: 2026-08-17
source: plan "Model catalogues from the harnesses themselves" (phase 4, personal/sway, branch `settings-and-chat`); `src/utils/modelCatalog.ts` (`ensureModelCatalogsLoaded`, `refreshDueCatalogs`); [[lesson_a_batch_answers_when_its_slowest_member_does]]
---

# A cached promise's value is the state of the world at first load

Do NOT decide anything from what a once-per-run promise resolved to. A read latched with `let p = p ?? invoke(...)` hands every later caller the **original** answer, which is correct for "have we loaded" and wrong for "what is true now": every update since has landed in the signal and nowhere else. `refreshDueCatalogs` awaited the cached `model_catalogs` read and then filtered *its* value for what was due, so a second Check-all re-probed harnesses that had answered seconds earlier - each spawn a real agent. Await the latch for its ordering, then read the **signal** for the state. The tell is a promise being awaited and its value used in the same expression.
