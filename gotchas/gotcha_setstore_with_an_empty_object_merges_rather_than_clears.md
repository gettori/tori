---
summary: a Solid setStore({}) shallow merges into the store and clears nothing, reset a keyed store with reconcile({})
status: current
updated: 2026-09-27
source: "plan "Show merged and closed PR status on worktree rows" (personal/tori, branch `misc-20260927`); commits 662596f1, 6cfe26b5, 2d139c7e, 4d8a5c5d; `src/utils/prRelation.ts:88`"
---

# setStore({}) merges rather than clears

Do NOT reset a keyed Solid store with `setStore({})`: an object argument is merged in, so every existing key survives. Use `setStore(reconcile({}))`. Why: `setStore` shallow merges objects by design, and a test reset that clears nothing leaks answers into the next test.

## Related

- [[lesson_a_cache_stamped_on_object_identity_thrashes_across_two_stores]]
