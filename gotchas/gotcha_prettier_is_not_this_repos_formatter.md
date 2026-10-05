---
summary: superseded by #257; the tree is formatted, so run vp fmt (Oxfmt) and cargo fmt, never prettier
status: stale
updated: 2026-10-06
source: plan "Tooling: one check everywhere, Vite+, formatters and linters", Phase 4, PR #257; commit "Format the tree with Oxfmt and rustfmt"; vite.config.ts fmt block; rustfmt.toml
---

# Prettier is not this repo's formatter

Superseded once #257 is on your branch. The tree is now formatted with Oxfmt (`vp fmt`, 120 columns, the `fmt` block in `vite.config.ts`) and rustfmt (`rustfmt.toml`, 120). Format with those, so a touched file stays clean. Prettier is still not the formatter, and its output does not match Oxfmt's.

On a branch cut before #257 the old rule holds: no formatter, edit by hand. Move it across with `scripts/reformat-branch.sh`.

## Related

- [[component_autopilot_cockpit]]: where it was hit
- [[gotcha_no_formatter_config_so_prettier_defaults_to_80_columns_here]]
- [[gotcha_bare_npx_prettier_reformats_this_repo_wholesale]]
