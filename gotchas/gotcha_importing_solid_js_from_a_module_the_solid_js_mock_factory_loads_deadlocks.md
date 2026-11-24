---
summary: a module the vi.mock("solid-js") factory imports must not import solid-js itself, or the mock waits on itself and the run hangs
status: current
updated: 2026-11-25
source: plan "Solid 2 stage D: write the app the 2.0 way" (branch `solid-2-stage-d-rest`, gettori/tickets#109), phase lists-patch-mode; src/test/perfCounters.ts (`countingSolid`); commit 1981349c
---

# Importing solid-js from a module the solid-js mock factory loads deadlocks

Do not `import { $PROXY } from "solid-js"`, or any other solid-js import, in a helper that a `vi.mock("solid-js", ...)` factory imports, such as `src/test/perfCounters.ts`. Take what you need from the `original` module the factory passes in, the way `countingSolid` takes `For`, `onCleanup` and `$PROXY`. Why: the import resolves to the mocked solid-js, whose factory is still waiting on that same helper, so the test file never starts and the run hangs with no error.

## Related

- [[concept_perf_budgets]] where `countingSolid` counts the render rows
