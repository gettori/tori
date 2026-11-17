---
summary: exec::common_dir answers the folder itself for a non-repo, so config written through it lands in folder/config; confirm with rev-parse first
status: current
updated: 2026-11-16
source: plan "Git accounts: identity, keys and a pick at clone" (personal/tori, branch `multi-git-account`); commits a1fecbef, 8935f287, 83f047dc, 86614ab1, 8acbb064, 66d873d8 (Phase 2 self-review S1); `src-tauri/src/exec.rs:229`, `src-tauri/src/forge/identity.rs:149`
---

# common_dir is not proof of a repo

Do not write git config to `exec::common_dir(path).join("config")` without first checking that the path is a repo. When `rev-parse --git-common-dir` fails, `common_dir` falls back to the folder itself, so an untrusted folder or a plain directory gets a stray `config` file in its root. Why: the helper is built for read paths that want an answer for any folder. Writers go through `Repo::open`, which checks trust and runs `rev-parse --path-format=absolute --git-common-dir` itself.

## Related

- [[component_git_account_identity]]
