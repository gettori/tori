---
summary: a chat session is exact, a PTY tab is a guess, a detached session caps at running, so only the PTY tier can starve
status: current
updated: 2026-07-31
source: Session navigation moves to a History dropdown; pi and opencode are removed (branch `navigation`, phases 3-6); `src/utils/sessionActivity.ts`; `src/utils/sessionStatus.ts:computeSessionDot`; commits 61eb767, a713a26
---

# Session certainty tiers

Tori knows what a session is doing three different ways, and they are not equally trustworthy. A **chat** session reports its own state over a structured protocol, so its status is *exact*. A **PTY agent tab** is inferred by joining PTY quiet against the transcript tail, so its status is a good guess. A **detached** session, one running outside Tori with no tab at all, is only known to exist because `pgrep` matched a pattern, so it caps at "running" and can say nothing more. Every status surface in the app is downstream of which tier a session is on, and the tiers explain most of what looks like inconsistency between them.

## How it works

`computeSessionDot` reads the tiers in order of certainty and returns on the first one that answers. It checks `chatStatus` on its very first line, so a chat session never reaches the code that consults `tailState`. Only the PTY tier performs the join, and only the PTY tier can therefore *starve*: if the session store is empty, `refreshTailStates` has nothing to join against, `tailState` stays unset, `blocked-candidate` never appears, and the needs-you pipeline silently stops firing.

That asymmetry is the single most important consequence: **any end-to-end check of the needs-you pipeline must use a PTY agent tab.** A chat-based test of the same pipeline passes against a build where the PTY tier is completely broken, because the chat tier answers before the broken code runs.

The detached tier is deliberately absent from `liveSessionStatuses`, which is built from live tabs and chats only - the things with a row to roll up *to*. A detached session therefore never reaches a sidebar rollup badge. Its status lives in `sessionStatus(id)`, which is what the History button's badge counts, and that badge is the only surface in the app where the detached tier is visible.

## Why it's this way

A tier that cannot distinguish "working" from "waiting on you" must not be allowed to claim either. `pgrep` proves a process exists and nothing else, so promoting a detached session past "running" would invent information. The same reasoning drives `capabilities.needs_you`: an adapter whose blocked-quiet join was never measured has its tail-derived `blocked-candidate` collapsed to `working` by `gate_tail`, capping it at the tier its evidence supports rather than risking a false amber.

The History button's badge is a **count, not a rollup**, for exactly this reason. A session with no tab caps at "running" by construction, so the four-state bubble the sidebar draws would only ever have shown one of its states there.

## Related

- [[component_session_stores]] — where each tier's inputs live, and what starves when the store is empty
- [[concept_needs_you_floor]] — the PTY tier's join, its quiet thresholds, and the capability gate
- [[component_history_dropdown]] — the only surface where the detached tier appears
- [[component_claude_hooks_status]] — the hook-driven override that outranks the tail join
- [[gotcha_only_the_pty_tier_can_starve_so_a_chat_based_needs_you_test_proves_nothing]] — the trap this concept exists to prevent
