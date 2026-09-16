---
summary: load_feature clones the stale stored record, a command that changed disk state must use reconciled_feature instead
status: current
updated: 2026-08-28
source: "Feature lifecycle, member management and repair (personal/sway, branch `feature-workspace`, issue #159) - phase 3 - `src-tauri/src/features.rs` `reconciled_feature`, commit ede61ff - _2026-08-28_"
---

# `load_feature` answers with the state its caller has just invalidated

Do NOT return `load_feature` from a command that changed the world on disk. Why: it clones the stored record, and `state` is only ever refreshed by `list_features`, so `relocate_member` answered with the `RepoMissing` a previous read had written and the row stayed broken until something else refetched. Use `reconciled_feature` (a `list_features` narrowed to the one id) from any command that repaired, moved or destroyed something. The exception is `build_member`'s callers, which write the member's state themselves under the same mutate.
