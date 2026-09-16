---
summary: after adding or removing an account, drop the model catalogue store and read it back or it shows unknown
status: current
updated: 2026-09-05
source: "plan \"Multi-account: pick, lock and default an account per session\" (personal/sway, branch `multiaccount`), phase 2 and follow-on; `src/panels/Settings/panes/AgentsPane/AgentAccounts.tsx` (`changed`); commits `aa084e0`, `ae1d87e`"
---

# A catalogue keyed per account has no row for an account added this run

After adding, renaming or removing an account, drop the catalogue store **and read it back**: `forgetModelCatalogs()` alone leaves every account reading "unknown" until Settings is reopened. Why: `model_catalogs()` enumerates rows from `accounts.json`, so the set of rows changes with the set of accounts, while the frontend store reads once per app run and nothing re-reads it on its own.
