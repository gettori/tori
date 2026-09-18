---
summary: an init line typed into a hosted shell is re-parsed, so unquoted args with spaces break resume
status: current
updated: 2026-07-17
source: Per-workspace terminal sessions (personal/tori, branch `topbar`); `src/panels/Terminal/Terminal.tsx` (`shQuote`, `agentInit`); commit fe02de4; see [[concept_shell_hosted_tabs]]
---

# A command seeded into a shell is re-parsed — quote its args

Do NOT build an agent tab's `init` line by naively joining `program` + `args` (`[program, ...args].join(" ")`); shell-quote each arg (`shQuote` in `Terminal.tsx`). Why: unlike a direct `CommandBuilder` spawn (which passes an exact argv `Vec`, no splitting), an `init` command is **typed into a hosted shell** and re-parsed by it, so a `pi --session "/Users/x/My Project/.pi/s.json"` word-splits on the space and resume fails. Tori manages user-named project folders, which can contain spaces, so this is reachable. Single-quoting each arg round-trips to the exact intended argv.
