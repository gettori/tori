---
summary: sharpening a stale guard to a per root generation while the cache stayed keyed on the root left a returning root blank
status: current
updated: 2026-08-27
source: "Features phase 5: unified changes and the git slot map (#157), branch `feature-workspace`, Phase 1, commit 9658cff, `src/utils/gitActions.ts:209,215`"
---

# A coalesce key must carry whatever the stale guard compares

## What happened

`gitActions` already coalesced concurrent refreshes of one root under the key `status:<root>`, and that was correct while the stale guard was a single `currentRoot`. Phase 1 replaced the guard with a per-root generation counter so a Feature could hold several slots at once. The coalesce key was left alone, because it was already per root, and that quietly created a bug the old shape could not have: a root that leaves the member set and comes straight back gets a new generation, but joins the read still in flight from the previous one. The guard then discards that answer as stale, and the slot stays blank until the next event fires.

## Why

A request cache and a stale guard are two halves of one identity question, and they have to be asking it the same way. The guard's identity was `(root, generation)`; the cache's was `(root)`. Any pair of requests the cache called the same and the guard called different has exactly one outcome: the cache serves one answer, the guard throws it away, and nobody is left to fetch again. The fix is one character of key, `status:<root>#<gen>`, so a new generation is a new question.

Worth noticing that making the guard *finer* introduced this. The coarse guard could not tell the two requests apart either, so the coalesced answer was accepted and the slot filled. Sharpening one half of a matched pair is not a safe local change.

## What to do next time

When you change what a stale guard compares, change the request cache's key in the same edit. State the identity once, in a comment beside both, and check the pair by asking: is there an input the cache calls the same and the guard calls different? If there is, that input is a permanent blank. The test that catches it is out-and-back: enter, refresh, leave, re-enter, and assert the slot fills.

## Related

- [[concept_per_member_git_slots]] - the store where both halves live.
- [[component_editor_stores]] - the module, and the coalescing it has done since wave 1.
- [[gotcha_a_request_bound_to_a_fast_changing_selection_needs_a_latest_request_wins_guard]] - the guard pattern this sharpens.
