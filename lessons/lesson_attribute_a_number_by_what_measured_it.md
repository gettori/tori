---
summary: a count keyed by activeId instead of a row's own members reads stale for a frame on every switch
status: current
updated: 2026-08-27
source: "Features phase 5: unified changes and the git slot map (#157), branch `feature-workspace`, Phase 4, commit 3a7e890, `src/panels/LeftSidebar/FeatureList.tsx:140,196`"
---

# Attribute a number by what measured it, not by what is selected

## What happened

The Feature row's change count first read the git slot map as a whole and showed the total on whichever row matched `activeId`. Both halves are defensible on their own: the slot map only ever holds the open Feature's roots, so its total *is* that Feature's total, and `activeId` *is* the open Feature. Self-review caught that they are two different rules that have to agree, and that they agree one effect-tick late. `activeId` comes from the sidebar's selection, the slots come from the editor's `enterRoots` effect, so a switch from Feature A to Feature B renders B's row with A's total for a frame.

## Why

The count was joined to the row by a coincidence rather than by identity. Nothing in the number said which repos it came from, so the code had to assert the link separately, and a separately asserted link can be false. It was false for a frame today; it would have been false for good the first time anything entered a root that was not the selected Feature's, a background prefetch or a peek.

Rewriting it as a sum over the row's *own* members (`gitStateFor(m.worktreePath)` per member) made the attribution structural. A Feature nobody opened has no slots for its roots, sums to zero, and says nothing without being told which row is selected. That deleted the `activeId` gate, deleted the store export added for the total, and turned "only the open Feature shows a count" from a rule into a consequence.

## What to do next time

When a display value comes from a shared store, derive it from the identity of the thing displaying it, not from a second signal that happens to point at the same thing. If you find yourself writing `x === active ? total : undefined`, the total is under-keyed: give it the key and the conditional disappears. Two rules that must agree will disagree, and effects settle in creation order, so "agree eventually" means "wrong for a frame" every single switch.

One consequence worth carrying: this makes root identity load-bearing. Two Features over the same repo do not collide only because a worktree path carries the Feature's slug, so the test fixtures had to stop using `worktreePath: null` for everything.

## Related

- [[concept_per_member_git_slots]] - the store the count reads one slot at a time.
- [[component_feature_list]] - the row, and why `FeatureItem` takes the number as a prop.
- [[lesson_a_per_row_value_hoisted_to_a_container]] - the same mistake in the other direction.
- [[gotcha_a_members_path_moves_only_repopath_survives_a_recreate]] - the other half of member identity.
