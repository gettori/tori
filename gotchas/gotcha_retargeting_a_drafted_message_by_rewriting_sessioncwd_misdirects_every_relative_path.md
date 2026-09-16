---
summary: setting sessionCwd to the repo a message is about misdirects every relative path safeSend relativizes
status: current
updated: 2026-08-27
source: Features phase 5 (#157), branch `feature-workspace`, `src/panels/Editor/ReviewPanel.tsx:437,448`, `src/utils/pathScope.ts` (`mentionPath`), commit 9687380, _2026-08-27_
---

# Retargeting a drafted message by rewriting sessionCwd misdirects every relative path

Do NOT set `SessionTarget.folderPath` / `sessionCwd` to the repo a message is *about*. Why: those two fields are the session's **real** cwd (`sessionCwd: s.cwd`, `LeftSidebar.tsx:2130`), and `safeSend` relativizes every `@path` in the text against them, so pointing them at another member hands the agent relative paths that name its own repo while meaning the one next door, and misleads the resume-into-a-tab path as well. To name files in a different member, leave the target alone and compose the paths yourself: `mentionPath(absolute, sessionCwd || folderPath)`, which stays relative while the agent runs there and goes absolute when it does not.
