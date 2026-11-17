---
summary: git clone -c include.path writes the include above [remote], so a local value set later wins; re-append it after the last managed key
status: current
updated: 2026-11-16
source: plan "Git accounts: identity, keys and a pick at clone" (personal/tori, branch `multi-git-account`); commits a1fecbef, 8935f287, 83f047dc, 86614ab1, 8acbb064, 66d873d8 (Phase 4 self-review, measured on git 2.54); `src-tauri/src/forge/identity.rs:233`
---

# A clone-time include sits above the repo's own sections

Do not assume an include written by `git clone -c include.path=<file>` outranks the repo's own values. It lands right after `[core]`, above `[remote "origin"]`, so a `git config user.email` run later appends a `[user]` section below it, and that value wins. Why: git config reads top to bottom and the last value wins. `Repo::outranks_own` checks `git config --local --list` order and re-appends the include only when a managed key follows it, so an unrelated `[branch]` section causes no churn.

## Related

- [[component_git_account_identity]]
- [[adr_git_account_delivery_by_repo_include]]
