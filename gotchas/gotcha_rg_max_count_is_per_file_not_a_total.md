---
summary: ripgrep's max-count limit applies per file, not as a global cap, so it cannot bound or signal a truncated total
status: current
updated: 2026-08-01
source: "Search panel v2 (branch `wave-1-2`); Phase 1; `src-tauri/src/search.rs:345`; PR #81"
---

# `rg --max-count` is per file, not a total

Don't use ripgrep's `--max-count` as a global result cap: with `--max-count 1` across two matching files it returns two matches, not one. Why: the limit is per file, so it can neither bound a total nor tell you a result set was truncated. Tori caps in `finalize` after verification and passes `--max-count max + 1` only as a coarse bound on how much JSON one pathological file can emit, the `+ 1` being what still trips the truncation flag when a single file overflows the cap alone.
