---
summary: closing stdin to deliver a mid turn message ends a stream json claude session, since it reads stdin until EOF
status: current
updated: 2026-07-29
source: Chat surface plan, phase 2 spike 5 (personal/tori, branch `chat`); [[concept_mid_turn_steer]]
---

# A stream-json CLI reads stdin until EOF

Do NOT close stdin to "deliver" a message to a running `claude` turn in stream-json mode, and do NOT hold a spike open on a short timeout: the CLI reads stdin until EOF, so closing it ends the turn, and any latency you measure right after a close is indistinguishable from "EOF is what delivered it". Hold stdin open (90s was enough) and the real answer appears: the model acted 1633ms after a mid-turn frame with stdin still open, against 4470ms when the harness closed it at 4s.
