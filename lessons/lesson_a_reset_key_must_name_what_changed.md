---
summary: an effect keyed on a value with two causes fires for the cause it did not mean, silently, since nothing ever fails
status: current
updated: 2026-08-27
source: "Features phase 4: unified search across member roots (#156), branch `feature-workspace`, phases 1 and 2, commits 92d697f and ec71908, `src/panels/Editor/SearchPanel.tsx` (`membersKey`, `rootsKey`)"
---

# A reset key must name what changed, not what moved with it

## What happened

`SearchPanel` clears its results, its history cursor, its recall draft, a half-typed saved-search name and the saved notice whenever you arrive in a different workspace. None of that means anything in the next project, and carrying it over is how the first arrow press after a switch puts someone else's half-typed text in the box.

It was keyed on `props.root`, which inside a Feature is the *active member*. A Toolbar chip moves that, so clicking a chip to read another member's file threw away a search that spanned all of them. Phase 1 fixed it by keying on `props.workspace` plus the searched root set, which was right at the time: the only thing that could narrow the searched set, other than a real workspace change, was a member going unusable, and a member that has just lost its worktree genuinely does invalidate a result set.

Phase 2 added a search-local member restriction. A chip in that row narrows the searched root set too, for a completely different reason, and the same effect fired. Clicking "just this member" now spent the history cursor and the half-typed name it had been fixed to protect one phase earlier.

The fix was to split the one derived value into two. `membersKey()` is every member the panel draws, restriction ignored, and the reset effect keys on that plus the workspace. `rootsKey()` is the set actually grepped, and it stays the dependency of the *outcome-retire* effect, which is exactly the place where "the searched set changed" is the right question to ask.

## Why

The searched root set was a convenient thing to depend on because it moved whenever anything interesting happened. That is precisely what makes it the wrong dependency: it had two causes, and the effect only meant one of them. An effect keyed on a value with two causes fires for the cause it did not mean, and it does so silently, because nothing failed. The reset ran, it ran correctly, it just ran on a click that meant something else.

The tell was there in phase 1 and readable only in hindsight: the justification written down for the key was "a member going unusable invalidates the results". That is a statement about *one* of the ways the set can move, which is a reasonable thing to write when there is only one, and a latent bug the moment a second appears.

## What it costs to get right

Two keys instead of one, both cheap string joins, and each named after the question its consumer asks rather than after the data it happens to read. `membersKey()` answers "which workspace am I in"; `rootsKey()` answers "what did I just search". When a third cause turns up, it lands on whichever of those it actually is, instead of on both.

Related: the same phase found that a raw NUL separator in the join was invisible in the source and passed every test, see [[gotcha_a_raw_nul_in_a_source_file_type_checks_and_passes_every_test]].

## Related

- [[component_search_panel]] - the panel, and the restriction row that exposed the collision.
- [[concept_member_fan_out]] - why the searched set is narrower than the member set in the first place.
- [[concept_feature_workspace]] - `wsKey` versus `activeRoot`, the split this is a downstream consequence of.
