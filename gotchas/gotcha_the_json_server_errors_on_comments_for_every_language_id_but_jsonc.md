---
summary: vscode json languageserver errors on comments for every language id except jsonc, use it for comment tolerant files
status: current
updated: 2026-08-08
source: "Editor wave 7: language intelligence depth, Phase 6 (personal/sway, branch `wave-7`); `src/utils/lspServers.ts`, `src/utils/swaySettingsFiles.ts`; commit 506d7e7"
---

# The JSON server errors on comments for every language id but `jsonc`

Do NOT open a comment-tolerant `.json` file as language id `json`. `vscode-json-languageserver` sets `{comments: 'error', trailingCommas: 'error'}` for every id except `jsonc` (`jsonServer.js:285`), so shipping it made Sway report every comment in the user's *own* `settings.json` as a problem, on every line. Both Sway settings files are read with json5. `languageIdFor` overrides to `jsonc` for those paths, gated on the server having advertised `jsonc`, and changes only the id, never which server is asked. Why: the language id is a validation mode here, not just a routing key.
