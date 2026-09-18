---
summary: a failed js-debug response has no message field at all, only body.error.format, so reading message renders failed
status: current
updated: 2026-08-11
source: "Editor wave 8: the debugger (DAP), Phase 9 (personal/tori, branch `wave-8`); `src/utils/dapClient.ts:176`; commit 1c1fbf6"
---

# js-debug sends no `message` on a failed response

Do NOT read `frame.message` first when surfacing a failed DAP request. A js-debug 1.117 failure carries **no `message` field at all**; the readable text is in `body.error.format`, with `{placeholder}` substitutions in `body.error.variables`. Reading `message` first turned every failure in the app into the word "failed" for six phases. Why: it is what the spec describes, every success-path test stays green, and the bug only surfaces in the one feature whose job is to show a refusal.
