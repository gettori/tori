---
summary: caretPositionFromPoint is chromium only, WKWebView answers inside a shadow tree so a drop point cannot be measured
status: current
updated: 2026-09-04
source: "\"Labelled path attachments in the chat composer\" (personal/sway, branch `bugfix-260903`), phase 2, `src/panels/Chat/Composer.tsx`, _2026-09-04_"
---

# `caretPositionFromPoint` does not exist in WKWebView

Do not build a drop-into-a-textarea interaction on the caret position under the pointer: that API is Chromium's, and WebKit's `caretRangeFromPoint` answers with a range inside the textarea's user-agent shadow tree that script cannot inspect. Why: the shipping webview on macOS is WKWebView, so the measured branch is the one that never runs. Fall back to the caret and say so rather than shipping an unverifiable branch.
