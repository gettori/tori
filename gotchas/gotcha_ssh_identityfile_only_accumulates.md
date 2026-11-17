---
summary: ssh IdentityFile accumulates across matching blocks, so an account key added by a later config block is offered after the user's own
status: current
updated: 2026-11-16
source: plan "Git accounts: identity, keys and a pick at clone" (personal/tori, branch `multi-git-account`); commits a1fecbef, 8935f287, 83f047dc, 86614ab1, 8acbb064, 66d873d8 (Phase 3, measured on OpenSSH 10.5); `src-tauri/src/forge/identity.rs:67`
---

# A later IdentityFile is offered last

Do not try to put an account's key first by adding an `IdentityFile` in a later `Host` or `Match final` block of an `-F` config that includes the user's own. ssh keeps the first value of most options, but `IdentityFile` accumulates, and keys are offered in the order they were read, so the user's key logs in first and the wrong account wins. A non-final `Match` also misses aliases. Why: `IdentityFile` is a list option, not a first-wins one. Pass `-i <key> -o IdentitiesOnly=yes` on the command line for the one host instead, which is what the per-account wrapper does.

## Related

- [[adr_git_account_delivery_by_repo_include]]
- [[component_git_account_identity]]
