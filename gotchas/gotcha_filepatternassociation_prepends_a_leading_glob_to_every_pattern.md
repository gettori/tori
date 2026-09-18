---
summary: vscode-json-languageservice prepends **/ to every pattern, so an absolute schema path matches only as a suffix
status: current
updated: 2026-08-08
source: "Editor wave 7: language intelligence depth, Phase 6 (personal/tori, branch `wave-7`); `src/utils/toriSettingsFiles.ts`; commit 506d7e7"
---

# `FilePatternAssociation` prepends a leading glob to every pattern

Do NOT build an absolute path for a JSON schema association expecting it to be matched as one. `vscode-json-languageservice` prepends `**/` to every pattern it is given (`jsonSchemaService.js:41`), so an absolute path out of the home directory is matched as a *suffix* regardless. Use a glob and say so, which is also what SchemaStore's own editor-config entries do (`**/.claude/settings.json`). Why: an absolute pattern implies a precision the matcher does not have.
