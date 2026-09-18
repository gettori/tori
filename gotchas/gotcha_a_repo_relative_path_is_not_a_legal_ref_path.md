---
summary: building a refs/ name straight from a file path breaks on leading dots, .lock suffixes and .., rejected by update-ref
status: current
updated: 2026-08-05
source: "Editor Wave 6: the IDE surface, Phase 15 (personal/tori, branch `wave-6`); `src-tauri/src/local_history.rs:71`; commit b622f33"
---

# A repo-relative path is not a legal ref path

Do NOT build a `refs/...` name out of a file path. A leading-dot component, a `.lock` suffix and a `..` sequence are all ordinary filenames and all rejected by `git update-ref`, so the failure arrives on somebody's real file rather than in testing. Hash the path instead, with an algorithm you have written down. The cost is that a ref name says nothing on its own and no listing can be derived from the ref store, which is fine while every entry is reachable from the file it belongs to.
