---
summary: beforeEach(() => fn.mockClear()) returns the mock, which vitest runs and awaits as a teardown, so the file hangs
status: current
updated: 2026-11-25
source: plan "Solid 2 stage D: write the app the 2.0 way" (branch `solid-2-stage-d-rest`, gettori/tickets#109), phase mutations-as-actions; extension/src/options/Options.test.tsx; commit dab2c717
---

# A beforeEach arrow that returns a mock hangs the suite

Do not write `beforeEach(() => set.mockClear())` with a concise arrow. Write `beforeEach(() => { set.mockClear(); })`. Why: `mockClear()` returns the mock function, vitest treats a function returned from `beforeEach` as that hook's teardown, and it then calls and awaits the mock. A mock whose implementation returns a promise that never settles hangs the file.

## Related

- [[concept_solid_2_conventions]] the action tests where this surfaced
