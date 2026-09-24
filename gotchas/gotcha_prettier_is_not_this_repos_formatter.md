---
summary: never run npx prettier here; the repo is not Prettier formatted and it rewrites whole files at any print width
status: current
updated: 2026-09-24
source: plan "Autopilot session and the cockpit (#205)" on branch orchestrator, issue gettori/tori#205, Phase 2
---

# Prettier is not this repo's formatter

Do NOT run `npx prettier` on a file here, not even on one you just touched. Why: the source was never Prettier formatted and no print width reproduces its style, so the run rewrites the whole file and buries the real change in noise. Restore the file and make the edit by hand in the surrounding style.

## Related

- [[component_autopilot_cockpit]]: where it was hit
