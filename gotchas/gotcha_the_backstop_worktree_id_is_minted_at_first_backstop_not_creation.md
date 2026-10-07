---
summary: a worktree has a backstop id only after its first discard, so the id cannot say Tori created it
status: current
updated: 2026-10-08
source: plan "Automatic worktree cleanup policy" on branch phase-1-block-1, ticket gettori/tickets#12; src-tauri/src/backstop.rs worktree_id
---

# The backstop worktree id is minted at the first backstop, not at creation

Do NOT use the backstop worktree id (`<gitdir>/tori/id`) as proof that Tori created a worktree. `backstop::worktree_id` writes it lazily the first time that worktree takes a backstop, so most worktrees, Tori-made or not, never have one. Why: the id exists to keep snapshots from leaking across a recycled name ([[concept_worktree_backstops]]), not to record provenance, and nothing at creation writes it. Gettori/tickets#12 assumed it did. See [[component_worktree_cleanup]].
