---
summary: claude -p --allowedTools Bash "prompt" takes the prompt as a tool name and fails; use --allowedTools=Bash or put the prompt first
status: current
updated: 2026-10-08
source: "Provenance plan, gettori/tickets#25 (branch phase-1-block-1), mid-turn fork measurement against claude 2.1.285"
---

# claude's --allowedTools swallows the prompt

Do NOT write `claude -p --allowedTools Bash "the prompt"`. The flag takes several values, so the prompt becomes a second tool name and claude exits with "Input must be provided either through stdin or as a prompt argument". Why: a probe built that way never starts the session it meant to measure, and anything waiting for its transcript waits forever. Write `--allowedTools=Bash`, put the prompt before the flags, and close stdin with `< /dev/null`.

## Related

- [[concept_ask_why_by_fork]] the measurement this broke
- [[gotcha_claude_ignores_an_unknown_flag_so_acceptance_is_not_evidence_a_flag_exists]] another way claude's argv misleads
