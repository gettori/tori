---
summary: a throwaway measurement harness had two bugs each recording a confidently wrong number, every miss a false negative
status: current
updated: 2026-08-14
source: Chat surface plan, phase 2 spike 5 (branch `chat`); spike code deleted, numbers recorded in the plan's phase 2 notes; third occurrence in "Defer permissions to the harness, and grow to four harnesses" phase 1 (branch `chat-fix`); `dev/protocol-probe.mjs`, scenarios `permission-coverage` and `permission-subagent`
---

# Debug the harness before recording the outcome

## What happened

A spike measured whether a mid-turn steer is consumed before the agent's next
tool call, which decided whether a whole phase was built or cut. Two bugs in the
*harness* had to be found first, and each would have produced a confidently wrong
recorded outcome.

First, the CLI reads stdin until EOF in stream-json mode, so holding it open
hangs the turn. The first run closed stdin after 4s and the model acted 4470ms
after the steer, which is indistinguishable from "EOF is what delivered it".
Holding stdin open for 90s instead showed the model acting at 1633ms with stdin
still open, which is the real answer. Second, the classifier required a *later*
tool call to conclude "before the next tool call", so a steer that pre-empted
every remaining call was mislabelled "acted on at turn end", which is the exact
value that would have cut the phase.

## Why

A measurement harness has the same defect rate as any other code, but none of the
scrutiny: it is throwaway, it is written fast, and its output is a number nobody
can sanity-check against anything. Both bugs produced *plausible* numbers. The
second is the more dangerous shape, a classifier whose failure mode is silent
misattribution rather than an error, and it happened to fail toward the
conservative answer, which is the answer least likely to be questioned.

## What to do next time

- **Before recording a spike result, ask what the harness would report if the
  effect were maximal.** Here a steer that pre-empted *every* remaining tool call
  was the best possible outcome, and the classifier had no bucket for it.
- **Suspect any measurement whose value sits near the boundary the harness
  itself imposes.** 4470ms against a 4s stdin timeout was the tell.
- **Vary the harness parameter and re-run.** If the number moves with the
  harness rather than with the thing being measured, the harness is what is being
  measured.
- **Keep the spike outside the repo** (this one lived in a scratch directory), so
  `git status` is clean by construction rather than by cleanup.

## It happened a third time, twice in one probe (2026-08-14)

"Defer permissions to the harness" phase 1 probed which tool classes raise
Claude's `can_use_tool` question, which is the gate the whole plan was built on:
had any class been silent, phase 2 was not allowed to begin. The probe recorded
two confident falsehoods before it recorded the truth.

It used `echo` for the Bash case and concluded **"Bash never asks"** - the CLI
safe-lists `echo`, so the silence was correct behaviour for that command and not
for the class. And it killed the child while a backgrounded subagent was still
working, concluding **"subagents never ask"**; the subagent asked after the probe
had stopped listening. Both are now guarded in committed scenarios that name a
genuinely gated tool and linger past the `result` frame.

The pattern across all three occurrences is the same and worth stating plainly:
**every wrong reading was a false negative**. The harness was quiet, and quiet
was recorded as absence. A probe that concludes "this never happens" deserves a
second look before one that concludes it does, because silence is what a broken
harness produces.

## Related

- [[lesson_fix_the_kill_threshold_before_measuring]] - the practice this protects
- [[concept_mid_turn_steer]] - the phase whose fate this spike decided
- [[lesson_a_capability_measured_signed_out_is_not_the_users_capability]] - the sibling: a probe that lies because of the account it ran under
- [[concept_pretooluse_capture_hook]] - the chain the third occurrence was probing
- [[gotcha_a_stream_json_cli_reads_stdin_until_eof]]
