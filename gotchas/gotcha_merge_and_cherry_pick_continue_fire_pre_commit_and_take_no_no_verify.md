---
summary: git merge --continue and cherry-pick --continue run pre-commit and take no --no-verify; use -c core.hooksPath=/dev/null
status: current
updated: 2026-10-06
source: plan "Tooling: one check everywhere, Vite+, formatters and linters", phase 7 self-review; measured on a scratch repo 2026-10-06; src-tauri/src/git.rs:1179, src-tauri/src/git.rs:3581
---

# merge and cherry-pick --continue fire pre-commit

Do NOT assume `--no-verify` on the original command covers its `--continue`. Why: `merge --continue` and `cherry-pick --continue` commit through `git commit` and fire the pre-commit hook, and `--continue` accepts no `--no-verify`; `rebase --continue` does not fire it (measured). Pass `-c core.hooksPath=/dev/null` before the subcommand instead, which wins over a repo's own `core.hooksPath`. Tori's `git_continue` does this through `HOOKS_OFF`.

## Related

- [[component_git_hooks]]
