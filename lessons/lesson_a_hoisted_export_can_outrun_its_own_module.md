---
summary: a dynamic import into a module inside an import cycle can call a hoisted export before the module body has run at all
status: current
updated: 2026-08-28
source: "Feature lifecycle, member management and repair (personal/sway, branch `feature-workspace`, issue #159) - phase 5 - `src/panels/Editor/lspWarmRoots.ts`, `src/panels/Editor/lspClient.ts`, `src/panels/Editor/Editor.tsx` (the `on(root, ...)` effect)"
---

# A hoisted export can outrun its own module

## What happened

Adding one more `Editor` mount to a test file surfaced an unhandled rejection that had been latent for months:

```
ReferenceError: Cannot access 'rootLru' before initialization
  touchWarmRoot   lspClient.ts
  retainLspRoots  lspClient.ts
  Editor.tsx      void import("./lspClient").then((m) => m.retainLspRoots(r))
```

A project switch reaches the LSP client through a **dynamic import**. `lspClient.ts` is in an import cycle: `lspCodeActions.ts` and `lspCodeLens.ts` both import back into it. Under that cycle the dynamic import can resolve while `lspClient`'s body has not executed a single statement. `export function` declarations are hoisted, so `retainLspRoots` was callable; the module-scope `const rootLru` it read was still in its temporal dead zone.

## Why the obvious fixes did not work

**Hoisting the declarations changed nothing.** Moving `const WARM_ROOTS` and `const rootLru` to the first line after the imports left the same error, because the body had not run at all. The error was not "declared too late", it was "the body has not started".

**Moving the state to a new module changed only the name in the error.** With the LRU extracted to a cycle-free `lspWarmRoots.ts`, the throw became `Cannot access '__vite_ssr_import_21__' before initialization`: in that state, Vite's own import bindings are `const`s in the dead zone too. **Anything a hoisted export reads from module scope is unreachable, imports included.**

## What actually fixed it

Do not enter the cyclic module at all for the part that runs on every call. `Editor.tsx` now touches the LRU through `lspWarmRoots` (no cycle, so it is fully evaluated before anything can leak) and reaches into `lspClient` only when a project actually fell off the warm end, which is rare and by then late enough that evaluation has long finished:

```ts
void import("./lspWarmRoots").then(({ touchWarmRoot }) => {
  const evicted = touchWarmRoot(r);
  if (evicted.length) void import("./lspClient").then((m) => m.stopEvictedLspRoots(evicted));
});
```

## What to do next time

- **A dynamic import into a module that is in a cycle is not safe to call synchronously on resolve.** Treat "who imports me back" as part of the contract of any `export function` a `import(...)` calls straight through to.
- **Read the error's second form.** `Cannot access '__vite_ssr_import_NN__'` is the same failure wearing a bundler's name, and it is the one that tells you the fix is structural rather than a reordering.
- **Renaming an export in this codebase costs a sweep.** `retainLspRoots` was stubbed in 31 `vi.mock("./lspClient", ...)` calls plus a source-scanning guard in `dapSessions.test.ts` that greps `Editor.tsx` for the call by name. Mechanical, but budget for it before promising a two-line fix.
- The estimate given before starting was "two lines". It was wrong in kind, not in size: worth saying so plainly rather than expanding the change quietly.

## Related

- [[component_lsp_host]] - the module the cycle is in.
- [[lesson_an_added_test_file_can_fail_an_unrelated_one]] - the neighbouring shape, where new test weight changes what the suite observes.
- [[lesson_a_test_that_passes_against_the_broken_code]] - the discipline that made the new test worth trusting in the first place.
