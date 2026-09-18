---
summary: a derived accessor over a store signal inherits the store's change rate, so an effect on it fires far more than meant
status: current
updated: 2026-08-26
source: "Editor wave 2: git depth (personal/tori, branch `wave-2`); Phase 6 (commit fecf42d); `src/panels/Editor/CommitLog.tsx`; hit twice more in Features phase 3: unified file explorer across member roots (branch `feature-workspace`, issue #155); phases 1 and 3, commits 8e5d0c3 and 7580a41; `src/panels/Editor/FileTree/FileTree.tsx`, `src/panels/Editor/Editor.tsx`"
---

# A Solid effect inherits the change rate of whatever its accessors read

## What happened

`CommitLog` refetched the branch's log in an effect keyed on the branch and the ahead/behind counts:

```ts
const branch = () => gitState().branch;
const aheadBehind = () => gitState().aheadBehind;
createEffect(on([branch, aheadBehind], () => void reload()));
```

That looks like "reload when the branch or its ahead/behind changes". It is not. `on` tracks whatever its accessors *read*, and both of these read `gitState()`, a single store signal. So the effect tracked the store, and the store is refreshed by every `refreshStatus`, which means every watcher burst, which means **every file save**. A log tab open beside an agent writing files refetched continuously.

It surfaced sideways, which is the part worth noticing. The self-review finding was a different bug ("a reload requested mid-fetch is silently dropped"), and replacing the refuse-to-start guard with a supersede token is what made the extra fetches visible: the token exposed that the effect was firing three times per `refreshGit` rather than once.

## Why

A derived accessor is not a derived *signal*. `() => gitState().branch` creates no new reactive node; it is a function that reads a coarse signal and then narrows the value, so every subscriber inherits the coarse signal's change rate and none of its narrowing. `createMemo` is what creates the node, and a memo only notifies when its own computed value changes.

## What to do next time

- **When deriving from a store signal, use `createMemo`, not a plain accessor**, any time the derived value is a dependency of an effect. For a value only read in JSX the extra fires are cheap; for one that gates a fetch, a subprocess or a write, they are not.
- **Suspect this whenever an effect fires more often than its named dependencies change.** The count is the tell, and a supersede token or a simple call counter makes it visible in a test.
- **Coarse stores make this the default failure, not the exception.** [[component_editor_stores]] deliberately holds git state in one signal so the panel and the palette cannot disagree, which is right, and it means every consumer that wants a narrower dependency has to say so explicitly.

## It happened twice more, and the fix was not always a memo

`on(dep, fn)` re-runs whenever the tracked accessor's **dependencies**
invalidate, not only when its **value** changes, which is the same rule seen
from the `on` side. `App.tsx` rebuilds a Feature's `Selection` on every
`config://changed`, and a Feature's member list is rebuilt on every
`features://changed`, so two effects named after their roots fired on every
tick of an unrelated event:

- **Phase 1**, `on(usable, ...)` in a tree section, where every tick re-read
  every root. Fixed with a transition guard, `(ok, was) => ok && was !== true`.
  A memo would also have worked; the guard was chosen because what the effect
  wants is the **edge** (a repaired member becoming usable) and the guard says
  so at the call site.
- **Phase 3**, the watcher effect keyed on the member roots, where every tick
  re-issued the whole watch set. Fixed with `createMemo(() => roots.join("\n"))`,
  because here the effect wants the **value**: string equality is exactly what
  makes moving the active root inside a Feature a no-op.

So the choice is not "always memo". Ask what the effect is reacting to. A value
you can compare wants a memo; an edge in a boolean wants an explicit
`was`-guard, which is cheaper and reads as the intent it has.

**Both were caught by a test that counted calls**, not by one that asserted the
outcome: the identity-churn test in phase 1, and an `fs_watch_set` call-args
test in phase 3. The count is the tell, as below.

## Related

- [[component_commit_history]] - where this fired, and what it cost.
- [[lesson_a_view_reused_across_tabs_needs_a_supersede_token]] - the other reactivity trap from the same phase, and the token that exposed this one.
- [[component_editor_stores]] - the shared store whose change rate is being inherited.
- [[lesson_pure_core_for_global_stores]] - the related discipline of keeping decidable logic out of the reactive layer entirely.
- [[component_project_file_tree]] - the two later sites, and the tests that counted the extra fires.
- [[concept_feature_workspace]] - the two coarse events (`config://changed`, `features://changed`) whose rate the effects inherited.
