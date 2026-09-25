---
summary: remounting a detach mode ChatView on the same tab id lets the old view's chat_detach cut the new one's listener; keep it mounted
status: current
updated: 2026-09-25
source: branch orchestrator for gettori/tori#207, commit c490ea9a; src/panels/Autopilot/Cockpit.tsx (live memo)
---

# A remounted chat view on a shared tab id is detached by the old one

**Symptom.** The cockpit's chat stopped updating live: new replies and question cards appeared only after switching to Workspace and back.

**Cause.** `chat_detach` is keyed by tab id, and every cockpit view uses the one tab id `autopilot-cockpit`. The chat slot was `live() ? <CockpitChat/> : undefined` with `live` a plain function, so each idle and working flip of the runner rebuilt the element: the new view attached, then the old view's cleanup detached the same tab id and took the new view's listener with it.

**Fix.** `live` is a `createMemo`, so the element is rebuilt only when the answer changes, not on every status event.

**Still open.** A real remount (a crash and a restart) can race the same way. The durable fix is a tab id per mount, or a detach that names the attachment rather than the tab.

## Related

- [[component_autopilot_cockpit]]: where it bit
- [[component_chat_host]]: `chat_detach`
