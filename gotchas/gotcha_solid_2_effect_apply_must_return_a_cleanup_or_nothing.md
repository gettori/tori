---
summary: a Solid 2 effect apply must return a function or undefined; a concise arrow returning a value halts all reactivity
status: current
updated: 2026-11-23
source: plan "Solid 2 stage C: the switch to Solid 2.0" (personal/tori, branch `solid-2-stage-c-the-switch`, gettori/tickets#108), phases 8 and 9
---

# An effect's apply must return a cleanup or nothing

Do not write the apply half of `createEffect` as a concise arrow around a call that returns a value, like `(v) => setThing(v)`. Why: whatever apply returns is taken as its cleanup, and anything other than a function or `undefined` throws "invalid cleanup value", which halts the reactive system for the whole app. Use braces: `(v) => { setThing(v); }`.

## Related

- [[gotcha_solid_2_reads_are_stale_until_flush]]: the other rule for writing inside apply
