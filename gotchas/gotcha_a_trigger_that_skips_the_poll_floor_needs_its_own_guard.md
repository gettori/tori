---
summary: a manual poll trigger skips the shared rate floor by design, so a button wired to it can trip the endpoint's 429
status: current
updated: 2026-09-06
source: "Agent usage preview plan (personal/sway, branch `agent-usage`), design pass after phase 5 . `src/utils/usagePoll.ts:70` . `src/utils/usageProbe.ts:169` . PR #169 . _2026-09-06_"
---

# A trigger that skips the poll floor needs its own guard

Do NOT wire a button straight to a `manual` trigger. `mayPoll` returns early for `manual` (`src/utils/usagePoll.ts:70`) because a switch just turned on has to produce the reading it promises, but a refresh button on that path lets a user ask the same endpoint three times in two seconds, and Anthropic's usage endpoint answers 429. Why: the floor exists for storms of events, and a person pressing a button repeatedly is a storm the design did not count. The two guards that fix it are a short gap of its own (`MANUAL_GAP_MS`) and dropping an ask while one is in flight.
