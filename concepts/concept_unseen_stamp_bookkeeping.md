---
summary: with no global scan to baseline from, a session stamps seen on first sight, and pruning a stamp must be folder scoped
status: stale
updated: 2026-07-31
source: "Daily-driver polish: unseen badge, copy actions, tab peek, restore (personal/sway, branch `main`); Phase 1; commit 83c0572; `src/utils/unseen.ts` (+ `unseen.test.ts`), `src/panels/LeftSidebar/LeftSidebar.tsx` (`noteScans`, the selection effect, `.unseenDot`)"
---

# Unseen-change stamp bookkeeping

> **Removed 2026-07-31.** The unseen dot was **dropped rather than rehomed**
> (branch `navigation`, phase 6, commit 61eb767), taking `utils/unseen.ts`,
> `noteScans`, `viewStamps`, the stamp effect and `.unseenDot` with it. Within a
> branch-scoped [[component_history_dropdown]], "unseen" and "live" are nearly
> the same set, and the residual case is what the History button's badge covers.
> Existing `sway.lastViewed` stamps were not migrated. **Kept** because the
> reasoning below is about a constraint that has not changed - `list_sessions` is
> still folder-scoped, so anything that ever wants a "since you last looked"
> signal faces the same no-global-baseline problem and should read this first.

How the sidebar decides a session row has moved since you last looked at it. A row badges when its `last_active` is newer than its **lastViewed stamp**. The whole design is shaped by one constraint: **there is no global scan to hang a baseline off**.

## Why stamp-on-first-sight, not a baseline event

`list_sessions(folder)` is folder-scoped (see [[component_session_scanner]]) — Sway never enumerates all sessions across all agents at once. So there is no moment at which "everything currently known" can be stamped as a baseline, and an upgrade launch cannot mark the world as seen.

The rule instead is **stamp-on-first-sight**: a session seen in any scan without a stamp gets stamped immediately, and its pre-stamp activity never badges. Consequences that fall out of this and are worth keeping straight:

- The upgrade launch shows **zero badges** in the launch workspace, because that workspace's first scan stamps everything in it.
- The first visit to a *second* workspace also shows zero, for the same reason, at that later moment.
- Absence of a stamp is therefore never "unseen"; it is "not met yet". `isUnseen` returns false with no stamp.

## Why the stamp carries a cwd

A stamp is `{ at, cwd }`, keyed `agent:id` (ids are only unique within an adapter). The `cwd` exists for exactly one purpose: **pruning has to be folder-scoped too**. When a scan of folder F returns a session set, a stamp missing from that set is only evidence of deletion if the stamp's cwd falls under F. Otherwise the scan simply never looked there, and dropping the stamp would make another workspace's sessions badge spuriously on next sight. `reconcileScan` encodes this with [[component_session_scanner]]'s same prefix rule (`isUnderPath`).

## First sight uses max(now, last_active)

Not `now`. A session that has been busy for days would otherwise badge the instant Sway meets it if its `last_active` were ahead of the local clock (skew, or a session written on another machine). Taking the max means first sight is never immediately unseen.

## Select and deselect both stamp

The selected row never badges, by construction. So turns landing *while* it is open are invisible, and stamping only on selection would make the row go unseen the moment you switch away. The **deselect stamp is the load-bearing one**: it covers the open period. The effect tracks the previously-stamped session in a closure variable and stamps both the outgoing and incoming selection on every selection change.

## Row-local, never rolled up

The dot is deliberately outside the status vocabulary ([[concept_needs_you_floor]]'s Waiting/Executing rollup): a bare filled circle, not a glyph + label, and it never bubbles to a parent row. Freshness is a per-row fact; the rollup answers a different question (does anything under here need me).

## Connections

- Reads `SessionMeta.last_active` produced by [[component_session_scanner]]; inherits its folder-scoped prefix rule.
- Renders in the sidebar row alongside, but deliberately not as part of, the status vocabulary of [[concept_needs_you_floor]].
- Pure core + thin store wiring, the same shape as [[lesson_pure_core_for_global_stores]].

## Related

- [[gotcha_counting_live_agents_by_tree_nodes_misses_subdir_agents]] — the same "a folder-scoped primitive is not a global one" trap.
- [[gotcha_a_persist_effect_derived_from_live_state_erases_everything_not_currently_live]] — the sibling localStorage mistake, caught in Phase 2 of the same ticket.
