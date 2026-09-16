---
summary: a poll floor keyed per agent while the work was per account left a second login refused forever with no error at all
status: current
updated: 2026-09-06
source: "Agent usage preview plan (personal/sway, branch `agent-usage`), design pass after phase 5 . PR #169 . `src/utils/usageProbe.ts:90` . `src/utils/usagePoll.ts:58`"
---

# Key a rate floor to the unit the work is about

## What happened

A second Claude login never appeared in the titlebar. Its settings were right, its Keychain item existed, the CLI agreed it was signed in, and the sweep that reads accounts on focus looped over both of them. It had simply never been read, not once, in days of use.

The poll floor was one clock per **agent** while the work it gated was per **account**. The sweep read the default login first, stamped the shared clock before its request, and the second login was then refused for the rest of the interval. The next sweep started at the default again and did the same thing. The second account was starved permanently, and nothing failed: no error, no backoff, no log line, just an account that was always the one asked second.

## Why

The floor was written to protect the process being spawned, which is genuinely a per-agent cost, and the comment said so. That reasoning is sound for the resource and wrong for the schedule. A clock answers "is this thing due?", and if it is keyed above the thing, the first item in a stable iteration order consumes every slot forever. The bug is invisible in a one-account install, which is every test and most machines, and it degrades silently rather than failing, so nothing surfaces it.

## What to do next time

Key a rate floor, a due-check or a last-run stamp to **the unit the work is about**, not to the resource the work happens to consume. When the resource really is coarser, express that separately: here the floor moved to the account and a per-agent promise chain took over the "one at a time" job, so two logins are still read one after the other rather than raising two Keychain dialogs at once.

Two smells worth naming, because either one would have caught this earlier:

- A schedule keyed above its unit, iterated in a stable order. Ask what happens to the item that is always second.
- A guard whose failure mode is an absence. Nothing here threw; the symptom was a row that never appeared, which reads as "no data" and sends you looking at the data.

## Related

- [[component_usage_pipeline]] - where the clock and the queue now live
- [[concept_quota_is_an_account_fact]] - why the account is the unit here at all
- [[concept_forge_rate_budget]] - the sibling scheduler, whose unit really is the coarser one, and why
- [[gotcha_a_trigger_that_skips_the_poll_floor_needs_its_own_guard]] - the other end of the same control
