---
summary: scripts/check.sh is the one list of what CI runs; passing check.sh all locally is passing every CI job, audit included
status: current
updated: 2026-10-06
source: plan "Tooling: one check everywhere, Vite+, formatters and linters", phases 1 to 6; PRs #257, #259, #260; scripts/check.sh:20, scripts/check.sh:41, scripts/check.sh:54; .github/workflows/check.yml
---

# Check script

`scripts/check.sh` holds every check CI runs, and each job in `.github/workflows/check.yml` calls one of its targets. The list exists once, so `scripts/check.sh all` passing locally means the pull request passes. Run it in full before opening or pushing to a PR.

## How it works

- `ts` (`scripts/check.sh:20`): frozen lockfile install (which also runs `prepare` and so installs the hooks, see [[component_git_hooks]]), `tsc --noEmit` for desktop and mobile, `vp fmt --check`, `vp lint --deny-warnings`, `pnpm test` (token guard then vitest), and both vite builds.
- `rust` (`scripts/check.sh:41`): `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` on both crates, desktop `cargo test`, mobile `cargo check`.
- `audit` (`scripts/check.sh:54`): `pnpm audit --prod` and `cargo-audit` on both lockfiles. It stops with the install line when `cargo-audit` is missing.
- `all`: the three in that order.

Rust is pinned in `rust-toolchain.toml` and Node in `.node-version`; CI and `release.yml` read both. A new stable Rust therefore cannot add a clippy lint and turn CI red without a commit.

## Why it is this way

CI never ran a vite build, which is how 26.1005.0 broke on the mobile build, and PRs went red on checks nobody ran before pushing. Lint runs with `--deny-warnings` because every default Oxlint rule is a warning, so failing only on errors would enforce nothing. The audit target calls `cargo-audit audit` directly: through `cargo audit`, rustup would install the whole pinned toolchain on the Ubuntu audit job just to read two lockfiles.

Never edit `check.sh` while it runs. Bash reads the file as it goes, and one run ended on a syntax error after every step had passed.

## Related

- [[adr_vite_plus_toolchain]] what the ts target's commands are
- [[component_git_hooks]] the subset that runs on commit and push
- [[gotcha_brew_rustup_ships_an_old_default_toolchain]] the toolchain pin
- [[gotcha_npm_test_is_check_tokens_plus_vitest_so_npx_vitest_run_skips_a_whole_guard]]
