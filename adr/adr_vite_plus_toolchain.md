---
summary: full Vite+ (Oxfmt, Oxlint, vp test) at 120 columns, tsc kept for types, clippy and Oxlint on deny, hooks from Vite+
status: current
updated: 2026-10-06
source: plan "Tooling: one check everywhere, Vite+, formatters and linters"; PRs #257 (Vite 8, Vite+, reformat), #258 (blame ignore), #259 (clippy), #260 (oxlint), branch vite-hooks; vite.config.ts:101, vite.config.ts:125
---

# Vite+ as the toolchain

## Decision

Vite+ 1.0 for dev, build, test, format, lint and hooks. Oxfmt and rustfmt at 120 columns, the width the code was already written at, with the whole tree formatted in one commit (`.git-blame-ignore-revs` hides it from blame). Type checking stays on `tsc`. Clippy runs with `-D warnings` and Oxlint with `--deny-warnings`. Hooks come from Vite+ (`vp config`, `vp staged`).

## Alternatives

- **Standalone Oxlint and Oxfmt, or Biome.** Rejected: Vite+ brings both plus the test runner and hooks under one config, and `vp migrate` needs Vite 8, which was due anyway.
- **`vp check`'s type check (tsgolint).** Rejected for now: it runs the TypeScript Go toolchain, not the pinned 5.6, so switching would be a type checker change of its own.
- **Folding `vitest.config.ts` into `vite.config.ts`, as Vite+ advises.** Rejected: the app config would carry both test projects. `vitest.config.ts` still takes precedence under `vp test`.
- **lefthook or husky.** Rejected: Vite+ ships the dispatcher, and Rust sits in the same `staged` block.
- **Errors only for lint.** Rejected: every default Oxlint rule is a warning, so it would enforce nothing.

## Consequences

- `vp migrate` also reformatted every file it touched at 80 columns and added Vitest 4 compat flags. Both were dropped; the suite passes on Vitest 5 defaults.
- Oxfmt skips Markdown, TOML, generated, vendored and captured files (`vite.config.ts:101`), see [[gotcha_oxfmt_reflows_markdown_into_a_different_meaning]] and [[gotcha_golden_files_are_compared_byte_for_byte_so_no_formatter_may_touch_them]].
- Three Oxlint rules are configured with their reason in `vite.config.ts:125`: `no-unassigned-vars` off (Solid refs), `unicorn/no-useless-spread` off (listener snapshots), `no-unused-vars` ignoring a leading underscore.
- A branch cut before the reformat crosses it with `scripts/reformat-branch.sh`.
- Vite 8 compiles with Oxc, see [[gotcha_oxc_honours_jsx_preserve_so_a_unit_test_importing_tsx_fails_to_parse]].

## Related

- [[component_check_script]]
- [[component_git_hooks]]
- [[gotcha_prettier_is_not_this_repos_formatter]]
