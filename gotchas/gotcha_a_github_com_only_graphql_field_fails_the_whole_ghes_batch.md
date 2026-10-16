---
summary: never add a github.com-only field to the shared GraphQL batch unguarded, GHES rejects the whole query; gate it on `versioned`
status: current
updated: 2026-10-16
source: "plan 'GitHub stacked PRs grouped in the left sidebar' (personal/tori, branch `github-stacked-pr`, gettori/tickets#15); commit bec432f6; `src-tauri/src/forge/github.rs:884` (`unit_statuses_watching`), test `only_github_com_is_asked_about_stacks`"
---

# A github.com-only GraphQL field fails the whole GHES batch

Do NOT add a field GitHub Enterprise Server may lack (`stack`, `stackEntry`, anything new on github.com) to `PR_FIELDS` or straight into the per-branch aliases. Append it only when the forge is `versioned`, the way `unit_statuses_watching` appends `STACK_FIELDS`. Why: an unknown field is a validation error for the whole document, so every branch in the project loses its status on that host, not just the new field.

## Related

- [[concept_native_stacks_are_read_never_inferred]] - the first field gated this way
- [[concept_forge_provider_seam]] - where the batched query lives
