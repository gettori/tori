---
summary: a resumed autopilot follows the brief in its transcript, so an edit to the opening steps must also go into RESUMED
status: current
updated: 2026-09-25
source: plan "Autopilot hard lock, release on stop, reconcile on start (#209)" on branch orchestrator, issue gettori/tori#209; commits 28f747ed, 32def50a, f29dfcbd
---

# A resumed autopilot keeps the brief it started with

Don't expect an edit to `resources/autopilot/brief.md` to reach a resumed autopilot. The brief is delivered only on a fresh start, and a resume sends `RESUMED` (`src-tauri/src/rpc/runner.rs`), so the model follows the old brief in its own transcript. Anything about the opening steps has to be written into `RESUMED` as well. Why: a start resumes unless the last session died or the agent changed ([[adr_every_autopilot_start_is_a_fresh_session]]), so most starts never see the new text.

## Related

- [[component_autopilot_runner]]: `RESUMED` and the launch
- [[adr_every_autopilot_start_is_a_fresh_session]]: why most starts resume
