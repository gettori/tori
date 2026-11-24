---
summary: Solid 2 useContext throws with no owner, so JSX built at module scope, like story args, crashes if a child reads context
status: current
updated: 2026-11-23
source: plan "Solid 2 stage C: the switch to Solid 2.0" (personal/tori, branch `solid-2-stage-c-the-switch`, gettori/tickets#108), phase storybook, commit 7964a55a; `.storybook/lazyArg.ts`, `src/components/Dialog/surface.ts:32`
---

# `useContext` throws without an owner

Do not create a component at module scope or in an ownerless callback if anything under it reads context. Why: 1.9 returned the default value there, while 2.0 throws "Context can only be accessed under a reactive root". `Button` reads one through `Tooltip`, so almost any tree qualifies. Dev can hide it, because the HMR wrapper gives a component an owner, so 39 stories failed only in the production Storybook build. For story args, wrap the JSX in `lazyArg` so it renders under the story.

## Related

- [[component_storybook_workshop]]: where it bit
- [[gotcha_solid_2_render_during_setup_flushes_other_effects]]: the other owner rule from the same phase
