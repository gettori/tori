---
summary: ripgrep's -w flag matches +foo and .env in ways a boundary-wrapped pattern cannot, so never mix rg and regex offsets
status: current
updated: 2026-08-01
source: "Search panel v2 (branch `wave-1-2`); Phase 1; `src-tauri/src/search.rs:345`; PR #81"
---

# `rg -w` is wider than `\b(?:pat)\b`

Don't treat ripgrep's `-w` as equivalent to wrapping a pattern in `\b(?:…)\b`, and never let rg decide matches while Rust decides offsets. Why: `rg -w` matches `+foo` and `.env`, which the `\b` form cannot (a `\b` before a non-word character requires a word character beside it), so the two matchers disagree precisely on patterns whose edges are non-word, which is ordinary code-search vocabulary; search would then report an offset the replace side does not consider a match at all. Tori passes the canonical pattern to rg as a plain `-e` and derives every offset from its own regex, see [[concept_canonical_matcher]].
