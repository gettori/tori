---
summary: the Agents settings page keeps its own health resource apart from the shared store, a rename needs onRecheck to refresh
status: current
updated: 2026-09-05
source: "plan \"Multi-account: pick, lock and default an account per session\" (personal/tori, branch `multiaccount`), follow-on; `src/panels/Settings/panes/AgentsPane/AgentsSection.tsx:267`; commit `ae1d87e`"
---

# The Agents page holds its own copy of the health sweep

Refreshing the shared `agentHealth` store is not enough to update Settings > Agents: `AgentsSection` has its own `createResource(() => invoke("agent_health"))`, so an account renamed or removed still shows its old name on the detail page until the page's own re-check runs or Settings is reopened. Why: the section paints before the store exists and kept its resource; anything mutating accounts has to go through the page's `onRecheck`, which refreshes both.
