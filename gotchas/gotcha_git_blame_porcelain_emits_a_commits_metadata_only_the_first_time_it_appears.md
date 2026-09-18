---
summary: git blame porcelain emits a commit's metadata only on its first line, hold the current commit across later bare headers
status: current
updated: 2026-08-02
source: "Editor wave 2: git depth (personal/tori, branch `wave-2`); Phase 8; `src-tauri/src/blame.rs`; commit ad173e9"
---

# `git blame --porcelain` emits a commit's metadata only the first time it appears

Don't write a blame parser that expects author and summary lines under every group header. Why: porcelain emits the metadata block once per commit; every later line of that same commit opens with a bare `<sha> <orig> <final>` header and nothing else. A parser that treats a metadata-less group as malformed, or resets its current commit at each header, attributes every line after the first occurrence to nobody. Hold the commit you are *inside* and only replace it when a new metadata block arrives. Separately, capture blame output **untrimmed**: a blank last line is a group whose source line is a lone tab, and a trimming capture helper eats it and shortens the line list by exactly one, silently.
