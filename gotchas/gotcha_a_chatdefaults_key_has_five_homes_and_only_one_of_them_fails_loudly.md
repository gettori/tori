---
summary: a new chatDefaults setting needs edits in five places, a missing Rust field silently defaults false for existing users
status: current
updated: 2026-09-07
source: plan "Chat composer Tier 1" (personal/tori, branch `composer-260907`), phase 2 . `src-tauri/src/settings.rs:287` . commit `39a05ac` . _2026-09-07_
---

# A `chatDefaults` key has five homes and only one of them fails loudly

Do NOT add a chat setting by editing the pane. Why: it lands in `settingsStore.ts` (type plus default), `settingsCatalog.ts`, `ChatPane.tsx` (the row **and** its id list), `settings.rs` (struct, `Default` impl, round-trip test literal) and `workspaceSettings.test.ts`'s literal. Only a missing pane row fails a test (`settingsPanel.test.tsx` holds catalogue-to-row parity); a missing Rust field reads as `false` for every existing user, so give a bool that should default on `#[serde(default = "yes")]` rather than a bare `#[serde(default)]`.
