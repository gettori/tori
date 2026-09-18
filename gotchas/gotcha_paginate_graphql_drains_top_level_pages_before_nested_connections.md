---
summary: the graphql walker drains every top level page first, only then fills nested connections, a mid walk read sees one page
status: current
updated: 2026-08-03
source: "Editor Wave 3: GitHub as a first-class surface (personal/tori, branch `wave-3`); Phase 1; `src-tauri/src/forge/http.rs:445`; commit 474f146"
---

# `paginate_graphql` drains top-level pages before nested connections

Don't assume the GraphQL walker fills a node's nested connection while walking to it. Why: it drains every top-level page first, then goes back and fills each node's nested connection, so a caller that reads a node mid-walk sees its first nested page only. This is also why there are two walkers and not one with a flag: REST pages by a `Link` header, GraphQL by cursors inside the payload.
