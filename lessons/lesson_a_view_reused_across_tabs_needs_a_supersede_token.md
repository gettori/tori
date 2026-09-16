---
summary: an unkeyed Show reuses a component across tabs, so a stale fetch can land in a view that has moved to another tab
status: current
updated: 2026-08-02
source: "Editor wave 2: git depth (personal/sway, branch `wave-2`); Phases 6 and 7 (commits fecf42d, b108974); `src/panels/Editor/CommitLog.tsx`, `src/panels/Editor/CommitDetail.tsx`"
---

# A view reused across tabs needs a supersede token

## What happened

The editor pane routes a tab to a view with `<Show>`, which is **unkeyed**. Switching from one `sway://commit/<a>` tab to `sway://commit/<b>` therefore does not remount `CommitDetail`: it changes its props. The in-flight fetch for commit `a` is still running, and when it lands it writes commit `a`'s subject and file list into a component now displaying tab `b`. The reader sees one commit's message over another commit's diff, with nothing anywhere reporting an error.

It was found twice. First in `CommitLog`, where the initial guard was "refuse to start a reload while one is in flight", which drops a legitimately newer request instead. Replacing that with a token fixed it. Then the identical bug appeared in `CommitDetail` in the next phase, which is what made it a lesson rather than a bug.

## Why

The instinct is that a component belongs to a tab, so switching tabs starts it over. In Solid that is only true if the `<Show>` or `<For>` is keyed on the thing that changed; an unkeyed `<Show>` deliberately reuses the DOM and the component instance. Everything that was correct about "this fetch belongs to this view" quietly stops being true, and the failure is a *stale value written into a live view*, which no error path can catch because nothing failed.

An in-flight guard reads as the fix and is not: refusing the second request is as wrong as accepting the first one late, just less visibly.

## What to do next time

- **In this pane, any per-tab fetch needs a supersede token.** Increment a counter when a fetch starts, capture it, and drop the result if the counter has moved by the time it lands. Not an in-flight guard, which discards the request the user actually wants.
- **Suspect it whenever two tabs of the same kind can exist.** The single-tab case is indistinguishable from correct, so the test has to open two and answer the first one last.
- **Mutation-check the fix.** Both of these are pinned by tests that fail when the token comparison is removed, which is what stopped the second occurrence from becoming a third.

## Related

- [[component_commit_history]] - both components this bit, and the fix in place.
- [[lesson_a_solid_effect_inherits_the_change_rate_of_what_it_reads]] - the sibling reactivity trap; adding the token here is what exposed that one.
- [[gotcha_a_request_bound_to_a_fast_changing_selection_needs_a_latest_request_wins_guard]] - the same shape one pane over, found earlier.
- [[gotcha_reordering_a_referentially_keyed_for_must_preserve_object_identity]] - the other side of Solid's keying model.
