---
summary: a space Topic reads as gone only once get_config has answered; before that known spaces is null and nothing is gone
status: current
updated: 2026-11-03
source: "Topics inside a space (personal/tori, branch `space-topic`, commits f53a6865, faa781a6, ec29f1c8, 00dea72a, ac6d9313, dd15b1a8, dc5dd445), `src-tauri/src/topics.rs:264`, `src/utils/topics.ts:71`, `src/panels/LeftSidebar/LeftSidebar.tsx:1460`"
---

# A gone space is unknown until the config loads

Don't treat a missing space list as "no spaces". Why: the sidebar learns which spaces exist from `get_config`, which answers after the Topic store, so for a moment every space Topic names a space the window has not heard of. Reading that as gone would flash every space Topic into Topics mode, with the "Tori can't find" note, on every launch. `spaceGone(space, known)` and `listsInTopics(topic, known)` (`src/utils/topics.ts:71`) take `known` as `null` until the config has landed and answer "not gone" for null; keep any new caller on that contract rather than passing `[]`. See [[concept_feature_workspace]].
