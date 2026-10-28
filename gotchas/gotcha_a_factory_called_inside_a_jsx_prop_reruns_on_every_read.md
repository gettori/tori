---
summary: never call a resource factory inline in a Solid JSX prop, props compile to getters and each read builds a new one, looping
status: current
updated: 2026-10-28
source: "Morning digest plan (gettori/tickets#37); `mobile/src/Inbox.test.tsx`; again in plan \"Shareable project config in the repository, trust-gated\" (branch shareable-project-config, gettori/tickets#49), `ProposalsSection.test.tsx` with `answered={createProposals(...)()}`"
---

# A factory called inside a JSX prop reruns on every read

Do not write `inbox={watchInbox(client)}`: create the watcher once and pass the variable. Why: Solid compiles a prop expression into a getter, so every `props.inbox` read builds a new resource, its fetch starts again, and the render never settles; a test hangs until its timeout with no output.

## Related

- [[component_digest]]
