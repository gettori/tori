---
summary: GraphQL mergeable reports conflicts only and knows nothing about branch protection, map it to unknown, never to clean
status: current
updated: 2026-08-03
source: "Editor Wave 3: GitHub as a first-class surface (personal/tori, branch `wave-3`); Phases 1 and 13; `src-tauri/src/forge/github.rs`; commits 474f146, 945c1bd"
---

# GraphQL `mergeable` is not REST `mergeable_state`

Don't read GraphQL's `mergeable` as the merge verdict. Why: it reports conflicts only (`MERGEABLE`/`CONFLICTING`/`UNKNOWN`) and says nothing about branch protection or required checks, so it has to map to `Unknown` rather than to `clean`; the real verdict is REST's `mergeable_state`, which is why [[concept_mergeability_is_asked]] reads that one.
