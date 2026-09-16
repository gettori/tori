---
summary: File.type is unreliable for source files since WebKit reports .ts as video/mp2t, classify by extension instead
status: current
updated: 2026-09-04
source: "\"Labelled path attachments in the chat composer\" (personal/sway, branch `bugfix-260903`), phase 1, `src/utils/chatCompose.ts:117`, _2026-09-04_"
---

# `File.type` is not evidence for a source file

Never classify a pasted or dropped file by its MIME type: WebKit reports `.ts` as `video/mp2t` and hands most source files an empty string. Why: the browser guesses from a table that predates the extensions a code editor cares about. Read the extension and consult the MIME only for a name that has none (`attachmentKind`).
