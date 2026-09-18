---
summary: a status color answered whether Tori could compare versions, not whether the agent was usable, downgrading it
status: current
updated: 2026-07-19
source: "v0.1 release gate: adapter cards, releases, light mode, polish (personal/tori, branch `topbar`); Phase 1; `src/panels/Settings/AgentsSection.tsx:39`"
---

# A status colour must encode the user's question, not the system's uncertainty

## What happened

The agent health cards have four outcomes: `not_found`, `version_match`, `version_drift`, `version_unknown`. The first mapping sent `version_unknown` to a gray dot, which felt obviously right: Tori does not know, so the indicator is neutral.

On the first real launch, two of three healthy agents rendered gray and second-class next to a green opencode. Both were installed, both worked perfectly, and both reported their versions fine (claude 2.1.215, pi 0.80.6). They were gray only because neither `claude.toml` nor `pi.toml` carries a `verified_against` value for Tori to compare against.

The same root cause had already bitten once, in copy rather than colour: the first card text said "version not reported" for those agents, which reads as a bug report against an agent that plainly reported one.

## Why

The dot and the text were answering two different questions and only one of them is the user's.

- The user's question: **"is this agent installed and usable?"**
- The question the gray dot actually answered: **"can Tori compare this version against a known-good one?"**

The second is Tori's own bookkeeping gap. Rendering it as a status colour publishes an internal limitation as a judgment about the user's setup. The colour channel is the highest-bandwidth, lowest-nuance thing on the card, and it had been spent on the least important distinction.

## What to do next time

Decide what question the **colour** answers before mapping any state onto it, and let it answer exactly one. Nuance goes in the text, which has room for it. Here: the dot now answers only "installed and usable", so `version_unknown` is **green**, and whether a version exists, and separately whether it can be compared, both live in the sentence underneath.

The generalisable test: if a state is neutral-or-worse purely because of something *your* system does not know, rather than something *the user's* system lacks, it should not be visually downgraded.

## Related

- [[component_agent_health_cards]] - where this landed.
- [[concept_needs_you_floor]] - the other place in this project where a dot's colour is a claim about the user's world; the same discipline applies.
