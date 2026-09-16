---
summary: a github 422's top level message says Validation Failed, the actionable sentence is in errors[]
status: current
updated: 2026-08-03
source: "Editor Wave 3: GitHub as a first-class surface (personal/sway, branch `wave-3`); Phase 3; `src-tauri/src/forge/github.rs` (`error_message`); commit 7f9be1a"
---

# A 422's actionable text is in `errors[]`, not `message`

Don't surface a GitHub 422 by reading the top-level `message`. Why: it says "Validation Failed" and nothing else; the sentence a user can act on ("No commits between main and X", "A pull request already exists") is inside `errors[]`, so an error path that only reads `message` shows a refusal that explains nothing. Note also that 422 here is not an "already exists" status, it is every validation failure.
