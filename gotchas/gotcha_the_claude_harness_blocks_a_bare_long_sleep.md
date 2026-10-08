---
summary: claude's harness refuses a bare sleep 45 at once, so a mid-turn probe needs another long command, such as a python sleep
status: current
updated: 2026-10-08
source: "Provenance plan, gettori/tickets#25 (branch phase-1-block-1), mid-turn fork measurement against claude 2.1.285"
---

# The claude harness blocks a bare long sleep

Do NOT hold a claude turn open with `sleep 45` to test something mid-turn. The harness blocks the long sleep and returns a result immediately, so the "mid-turn" moment is already over by the time the probe acts, and the measurement silently tests an idle session. Why: the tool result lands before the probe looks. Use `python3 -c 'import time; time.sleep(45)'`, and check the transcript has a `tool_use` with no `tool_result` yet before acting.

## Related

- [[concept_ask_why_by_fork]] the measurement this nearly invalidated
