---
summary: folder_verdict auto adopts a folder and writes adopted.json, a session listing must never call or fetch it eagerly
status: current
updated: 2026-07-31
source: Session navigation moves to a History dropdown (branch `navigation`, phase 2); `src/utils/sessionStore.ts:142`, `src-tauri/src/sessions.rs`; commit a713a26
---

# Listing a folder's sessions must never ask for the historical verdict

Do not fold `folder_historical` into a session listing. `folder_verdict` returns `AutoAdopt` and **writes `adopted.json`**, so eagerly fetching would silently adopt folders the user never opened and permanently disable their ghost protection. Why: adoption is a user-visible, irreversible decision. `checkHistorical` is the deliberate call, made only where the Historical section is about to render.
