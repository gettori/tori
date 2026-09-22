---
summary: chatBudget.ts enforces spend ceilings at the turn boundary, refusing the next turn, so a running turn always finishes
status: current
updated: 2026-08-14
source: "\"Defer permissions to the harness, and grow to four harnesses\" (phase 2, branch `chat-fix`); originally Chat surface plan, phase 7 (branch `chat`); `src/utils/chatBudget.ts`; `src/panels/Chat/chatStore.ts` (`pendingFlush`)"
---

# Spend ceilings

A chat stops when it reaches a cost or context ceiling. The enforcement point is **the turn boundary**: Tori declining to open the next turn. It needs nothing from the harness, which is the property that matters most about it.

**The enforcement point moved, and the old reasoning is worth knowing because it was good reasoning about a world that ended.** Until 2026-08-14 the ceiling was a `stop` field on the Tori-owned rule file that the `PreToolUse` helper read on every tool call, chosen there rather than at the approval socket because a `Read` covered by an allow rule never opened a socket, so a socket-side ceiling was one that any session which had allow-listed its reads walked straight past. That was correct. It stopped being *available* when Tori stopped deciding tool calls at all: with no gate, there is no call to refuse.

## How it works

`breach(spend, budgets)` (`chatBudget.ts:57`) answers whether a ceiling is crossed and `approaching` (`:71`) whether one is near. `pendingFlush` in the chat store checks before opening a turn. The module is pure, so the one thing that matters here - that a ceiling stops a session exactly once, at a boundary, with a message naming what to do about it - is testable without a running agent.

**A running turn is allowed to finish.** The turn that crosses a ceiling is not the turn that is stopped; the stop applies to the next one. Interrupting a live turn would end work mid-edit to save the fraction of a turn's cost that remained, which is the wrong trade for a limit measured in dollars per session.

**The check lives in `pendingFlush` rather than in the queue hold**, because `releaseQueue` is wired to a "send now" button, and a ceiling a button can lift is not a ceiling.

**Nothing is told to the model any more.** There is no denial to attach a reason to, and a message injected into the transcript to announce the ceiling would itself be a new turn: the exact thing being prevented. So `stopNotice` (`:106`), `heldNotice` (`:116`) and `warnNotice` (`:123`) are all user-facing, and the deliberately un-arguable model-facing reason that [[lesson_a_denial_names_the_fix_but_the_retry_may_not_carry_it]] shaped is retired along with the denial that carried it.

**Usage is one map per project**, not one per session and not one global map. Keying by project keeps each rewrite bounded by one project's sessions instead of a machine's whole history, and reuses the `project_state_path` shape (now `src-tauri/src/owned_state.rs:27`) the counts store established.

**The floor caveat is conditional.** `observationComplete` compares the turns a `result` frame was seen for against the transcript's human-prompt count, so a chat that watched every turn reports an exact figure instead of warning that a correct number might be short. It errs to the caveat on every uncertainty: an unread transcript reports 0 prompts, which must not read as "nothing to account for, therefore complete".

## Why it's this way

**No interrupt was built, because the measurement said none was needed** - and the measurement has since been overtaken. A spike put three trials through a terminal denial offering no way forward: all three stopped on the first refusal, four tool calls each, no retry, no `Bash` workaround. That justified dropping the interrupt half rather than shipping it untested. The turn-boundary move makes the question moot in a stronger way: there is no denial at all now, so there is nothing for a model to work around.

**Not every harness can have one, and the reason is not the one this project first wrote down.** [[concept_harness_capability_tiers]] publishes `spendCeilings: false` for ACP, and the original explanation - that ceilings ride the Claude-only hook - was falsified by the move to the turn boundary. The real reason is that **ACP reports no cost**: `session/update`'s usage carries context occupancy (`used` of `size`) and no money, so a ceiling in dollars would never fire. Measured in phase 8, the native `codex app-server` reports the same, so this is not a wrapper's shortfall. Publishing such a ceiling as armed is the one failure a spend ceiling must not have.

**One limitation, stated not fixed.** If the model catalogue has not loaded, `contextWindow` is null and the context ceiling silently never fires. It degrades safe, but it is silent, and the money ceilings do not share the failure.

## There is a call to refuse again, and ceilings still do not ride it (2026-09-23)

Not built: gettori/tori#203 plans a refusal point for outward actions from a session flagged `background`, which undoes the premise above that with no gate there is no call to refuse. Ceilings stay at the turn boundary anyway, since widening that gate to cost would grow it back into the general permission layer [[adr_harness_breadth]] retired. See [[adr_a_background_session_needs_a_tori_gate]].

## Related

- [[concept_harness_capability_tiers]] - where a harness's ability to carry one is published, and why ACP cannot
- [[concept_pretooluse_capture_hook]] - the mechanism this used to ride, and no longer needs
- [[component_settings_store]] - where the ceilings are set
- [[lesson_a_denial_names_the_fix_but_the_retry_may_not_carry_it]] - the measurement that shaped the retired model-facing reason
- [[gotcha_a_frontend_settings_key_with_no_rust_field_is_dropped_on_save]]
- [[concept_quota_is_an_account_fact]] - the harness's own limits, which share this vocabulary and come from the account rather than from Tori.
- [[adr_a_background_session_needs_a_tori_gate]] - the new refusal point, and why ceilings deliberately do not use it
