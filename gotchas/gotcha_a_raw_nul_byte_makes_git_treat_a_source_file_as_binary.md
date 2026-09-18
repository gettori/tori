---
summary: a literal NUL byte in a source file makes git diff it as binary with no patch shown, write the escape instead
status: current
updated: 2026-08-03
source: "Editor wave 4: language intelligence foundations (personal/tori, branch `wave-4`); Phase 3 (found, pre-existing since Phase 2); `src/panels/Editor/lspClient.ts`; commit c5dac84"
---

# A raw NUL byte makes git treat a source file as binary

Do NOT write a literal `\0` into a source file as a separator — write the escape. Git sniffs the first 8000 bytes for NUL and, finding one, treats the file as **binary**: `git diff` then reports `Bin 4112 -> 9398 bytes` with no patch at all. `lspClient.ts` carried one at byte 1467 as a session-key separator, so the commit that rewrote that file shipped with its centrepiece diff unreviewable, and nobody noticed until a later phase went looking for something else. Two other files in this repo have the same habit but sit past the sniff window, so they still diff — which is exactly why the failure is easy to miss.
