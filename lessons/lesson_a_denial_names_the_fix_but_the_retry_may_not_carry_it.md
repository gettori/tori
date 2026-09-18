---
summary: a denial naming its fix triggers a retry, but only 7 of 9 trials actually re-read first, so recheck on the retry itself
status: current
updated: 2026-08-14
source: Chat surface plan, phase 2 spikes 2 and 3 (branch `chat`); `src/utils/chatBudget.ts`; commit "Stop a chat at a spend ceiling, from the file the hook already reads"; superseded in part by "Defer permissions to the harness, and grow to four harnesses" (phase 2, branch `chat-fix`)
---

# A denial names the fix, but the retry may not carry it

## What happened

Two spikes measured how the agent reacts to a `PreToolUse` denial, at n=3 each
against claude 2.1.220.

**A denial that names its fix produces a retry, reliably.** Nine denials of the
form "this file changed on disk after you last read it, re-read it then apply
your edit" produced nine recoveries and zero give-ups. But only **7 of 9**
actually re-read first. In one trial the model retried the second and third
denials without re-reading, having already read those files earlier in the turn.

**A terminal denial stops the agent dead.** Three trials denied every write with
a spend-ceiling reason offering no recovery. All three stopped on the first
refusal: four tool calls each, no retry, no `Bash` bypass, no alternative
approach, and the turn closed with a report naming the unapplied edits and why.

## Why

The two results come from the same mechanism read in opposite directions. A
denial reason is a prompt, so it steers the *next* action strongly, but it does
not compel the model to reconstruct state it believes it already has. "Re-read
it" competes with the model's own memory of having read it, and sometimes loses.

## What to do next time

- **Never let a guard trust that the retry carries fresh content.** Re-check on
  the retry itself. A guard whose correctness rests on the denial having caused a
  re-read is wrong roughly one time in five.
- **When a retry is exactly what must not happen, write a reason with no remedy
  in it.** A terminal denial works. Say the limit is settled, forbid finding
  another route, and ask for a summary.
- **Tell the model and the user different things.** The user's message must name
  the remedy the model's must not.
- **Treat all of this as observation, not contract.** n=3, one CLI version.
  Record the version next to the behaviour and name the single predicate to flip
  if a later one starts working around the refusal.

## What this no longer applies to (2026-08-14)

**Tori has no denial left to write a reason into.** The spend ceiling was this
measurement's one production consumer, and it moved to the turn boundary when
Tori stopped deciding tool calls: enforcement is now `pendingFlush` declining to
open the next turn, so there is nothing to refuse and nothing to tell the model.
The "two audiences" rule survives in the vault as a rule and is not currently
exercised by any code.

**The measurement itself is untouched and is the reason to keep this page.** Both
halves are facts about how a model reacts to a refusal, not about Tori's
architecture. The first half in particular - that a denial naming its fix
produces a retry every time but the re-read only 7 times in 9 - is a live
constraint on **any** guard whose correctness depends on the retry carrying fresh
content, and Tori will write more of those. The `PreToolUse` hook both spikes rode
now only captures ([[concept_pretooluse_capture_hook]]), so a future guard of this
shape would have to be built somewhere else, which makes the takeaway more worth
remembering rather than less.

## Related

- [[concept_spend_ceilings]] - the design this measurement shaped, and which has since moved off it
- [[concept_pretooluse_capture_hook]] - the hook both spikes rode, which no longer denies anything
- [[lesson_debug_the_harness_before_recording_the_outcome]]
