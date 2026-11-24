---
summary: Solid 2 reads return the old value until flush, so whole-record updates in an effect lose writes; use an updater
status: current
updated: 2026-11-23
source: plan "Solid 2 stage C: the switch to Solid 2.0" (personal/tori, branch `solid-2-stage-c-the-switch`, gettori/tickets#108), phases 9 and 10; `src/panels/Terminal/terminalTabStore.ts:161`
---

# Reads are stale until flush

Do not write `set({ ...read(), key: value })` inside an effect run or any other place that cannot flush. Why: `read()` still returns the value from before the last write, so two such updates in one run keep only the second, and `flush()` is a no-op in an effect callback. Use an updater, `set((prev) => ({ ...prev, key: value }))`, which sees the pending value. This lost terminal tab wakes, debug watches and breakpoint updates during the port.

## Related

- [[adr_live_state_for_module_signals]]: how module state keeps 1.9's read-back outside effects
- [[gotcha_solid_2_effect_apply_must_return_a_cleanup_or_nothing]]: the other rule for writing inside apply
- [[gotcha_solid_2_render_during_setup_flushes_other_effects]]: what an ill-timed flush does instead
