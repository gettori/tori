---
summary: xterm fires onData for a running program's own replies too, so it is not proof anyone touched the keyboard
status: current
updated: 2026-09-06
source: "plan \"Standalone terminals: Sway's own commands as tabs in a Shells workspace\" (personal/sway, branch `standalone-terminals`, issue #166), Phase 4; `src/panels/Terminal/TerminalView.tsx:310`; commit `dd5c029`"
---

# `onData` is not a "the user typed" signal

Do NOT read `term.onData` firing as proof somebody touched the keyboard: xterm raises it for the terminal's own replies as well (a Device Attributes answer to a query the running program sent), so an interactive command produces `onData` traffic with nobody at the keys. This is why a command tab auto-closes on a clean exit unconditionally rather than "unless you typed in it"; there is no user-input signal at this seam to gate on.
