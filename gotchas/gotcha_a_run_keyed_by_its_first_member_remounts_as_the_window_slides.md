---
summary: windowed drops the head row on every append past 60 items, so key a derived group by its members, never its first row
status: current
updated: 2026-10-02
source: plan "Collapse agent work into one line cards" (personal/tori, branch `performance-20261002`), found by the adversary pass before any code; `src/panels/Chat/chatStore.ts:2135` (`windowed`), `src/panels/Chat/toolRenderers.ts:208` (`groupRuns`)
---

# A run keyed by its first member remounts as the window slides

Do NOT give a group built over `shown()` an identity taken from its first row. Why: `windowed` returns the last `limit` items (60 to start), so once a session is longer than that every append drops the head, the top group's first row changes each time, and `For` remounts that group on every item the agent emits, closing a card the reader opened and remounting its diffs.

`groupRuns` maps every member id to its wrapper and lets a run reuse the wrapper of its first already known member. That survives a clipped head, growth, and two runs merging. A wrapper is claimed once per pass, so a run that splits (a call inside it starts waiting on approval) gives its second half a new one.

## Related

- [[concept_collapsed_agent_work]] the feature this came from
- [[gotcha_reordering_a_referentially_keyed_for_must_preserve_object_identity]] the same `For` rule from the reorder side
