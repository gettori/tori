---
summary: never call render() during a component's setup on Solid 2; its flush runs queued effects under that owner and halts dev
status: current
updated: 2026-11-23
source: plan "Solid 2 stage C: the switch to Solid 2.0" (personal/tori, branch `solid-2-stage-c-the-switch`, gettori/tickets#108), phase storybook, commit 7964a55a; `src/panels/Chat/composerField.ts:40`
---

# `render()` during setup flushes other effects

Do not call `render()` from a component body or from anything it runs synchronously, such as a CodeMirror widget built during setup. Why: `render` ends in `flush()`, which runs the effects already queued under the current owner, so their writes throw `REACTIVE_WRITE_IN_OWNED_SCOPE` and halt reactivity in dev builds. The guard is not in the production bundle, so production only runs those effects early. Composer chips hit this when a draft with a chip mounted. Use `createRoot` plus `insert`, and `registerDelegatedRoot` so delegated handlers still fire: `mountChip` does all three.

## Related

- [[adr_live_state_for_module_signals]]: the wrapper skips its flush under an owner for the same reason
- [[gotcha_solid_2_reads_are_stale_until_flush]]: why flush matters at all on 2.0
