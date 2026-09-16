---
summary: unsanitized pasted text can smuggle the bracketed paste terminator, getting typed as commands at a live agent prompt
status: current
updated: 2026-08-03
source: "Editor Wave 3: GitHub as a first-class surface (personal/sway, branch `wave-3`); Phase 12 self-review; `src/utils/safeSend.ts:93`; commit d0d9a3e"
---

# A bracketed-paste payload must never contain the terminator

Don't put text you did not author into a bracketed paste without stripping control bytes. Why: the payload is wrapped in `ESC[200~ ... ESC[201~`, so a body carrying that terminator ends the paste early and the terminal takes everything after it as typing at a live agent prompt. `sanitizeForSend` maps tab to space and removes the rest of C0/C1, which is why the guard lives on the shared send path and not in one composer. See [[lesson_sanitize_text_you_did_not_author]].
