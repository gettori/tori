---
summary: Vite+ hooks format staged files on commit and type check plus build on push; Tori's own git writes skip every hook
status: current
updated: 2026-10-06
source: plan "Tooling: one check everywhere, Vite+, formatters and linters", phase 7, branch vite-hooks; .vite-hooks/pre-commit; .vite-hooks/pre-push; vite.config.ts:120; src-tauri/src/git.rs:1176, src-tauri/src/git.rs:1179, src-tauri/src/git.rs:4285
---

# Git hooks

`pnpm install` runs `prepare: vp config --no-agent`, which writes a dispatcher to `.vite-hooks/_` and points `core.hooksPath` at it. The project's own scripts are `.vite-hooks/pre-commit` (`vp staged`) and `.vite-hooks/pre-push` (both `tsc` runs and both vite builds). Tests stay in [[component_check_script]] and CI.

## How it works

- The `staged` block (`vite.config.ts:120`) runs `vp check --fix` on every type Oxfmt formats and `rustfmt` on `src/` and `build.rs` of both crates. `vendor/` is left out because Cargo checksums those files. Oxfmt honours `ignorePatterns` for explicit paths, so generated and golden files stay untouched.
- The dispatcher is generated and gitignored, one per checkout, but `core.hooksPath` lives in the shared `.bare/config`. A worktree that has not run `pnpm install` has no dispatcher, and git then runs no hooks there at all, silently.
- The dispatcher appends `~/.vite-plus/bin` (a global `vp`, possibly an old one) to PATH. Both scripts therefore test `node_modules/.bin/vp` directly and skip with a warning when it is missing, rather than trusting `command -v vp`.
- Turn hooks off for one command with `VP_GIT_HOOKS=0`, or for a clone with `vp hooks disable`.

## Tori's own git writes

Every commit and push Tori makes passes `SKIP_HOOKS` (`--no-verify`, `src-tauri/src/git.rs:1176`): `git_commit_body`, `push_branch` (also PR create and the push button), `push_sha` and `git_merge`. `git_continue` runs with `HOOKS_OFF` (`-c core.hooksPath=/dev/null`, `git.rs:1179`), see [[gotcha_merge_and_cherry_pick_continue_fire_pre_commit_and_take_no_no_verify]]. Inside the app a hook would block the UI for a whole pre-push build, or fail on a PATH without node; CI is the backstop. `toris_commits_and_pushes_skip_the_repos_hooks` (`git.rs:4285`) installs refusing hooks through a repo-local `core.hooksPath`, which wins over a global one, and fails if the flag is dropped from any call site.

## Related

- [[component_check_script]]
- [[adr_vite_plus_toolchain]]
- [[gotcha_merge_and_cherry_pick_continue_fire_pre_commit_and_take_no_no_verify]]
