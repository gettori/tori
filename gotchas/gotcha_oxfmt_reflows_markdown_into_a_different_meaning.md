---
summary: Oxfmt reflowing Markdown turned the changelog line "+ is gone" into a list item, so Markdown stays on its ignore list
status: current
updated: 2026-10-06
source: plan "Tooling: one check everywhere, Vite+, formatters and linters", phase 4 (reformat), PR #257; CHANGELOG.md; vite.config.ts:101
---

# Oxfmt reflows Markdown into a different meaning

Do NOT let Oxfmt format Markdown here. Why: prose wraps where it happens to, and a wrapped line that starts with `+` or `-` becomes a list item; the dry run turned the changelog's "the new space + is gone" into a bullet. `**/*.md` is on the ignore list for that reason.

## Related

- [[adr_vite_plus_toolchain]]
