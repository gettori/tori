---
summary: the blocking tier token guard only reads Chat.module.css, so a new module using a blocking token still passes unseen
status: current
updated: 2026-09-06
source: "Agent usage preview plan (personal/tori, branch `agent-usage`), phase 2 . `scripts/check-tokens.mjs:733` . `src/components/UsageStrip/UsageStrip.module.css` . PR #169 . _2026-09-06_"
---

# Check 10 only scans the chat panel's stylesheet

Do NOT assume the blocking-tier guard sees your file. `scripts/check-tokens.mjs:733` reads `src/panels/Chat/Chat.module.css` and nothing else, so a new module naming `var(--blocking-*)` passes the whole suite while breaking the rule the check exists to state, that the tier means "this stopped the turn" and means less on every extra surface wearing it. Why: the check was written to prove the two chat surfaces agree with each other, not to police the repo. A quota bar makes the same claim the chat's reached banner does, so it wears the same `--danger-fg` that banner does.
