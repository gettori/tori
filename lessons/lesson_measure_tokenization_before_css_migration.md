---
summary: before scoping a big CSS migration, count var() versus hardcoded hex, an old monolith may already be mostly tokenized
status: current
updated: 2026-07-13
source: Central configurable UI system (personal/tori, branch code-mirror-6); Phases 5a, 5b; commits abe9429, 932f8ef; `src/App.css`, `src/styles/tokens.css`, `src/theme/bundled.ts`
---

# Measure token coverage before scoping a big CSS migration

## What happened

The plan scoped a large Phase 5: migrate the ~2015-line `App.css` monolith to hash-scoped CSS Modules, cluster by cluster (5a–5e), to unlock light mode. Mid-execution, before doing the blind rewrites, I actually **counted** the CSS: App.css was already **~80% tokenized** (212 `var()` references vs 55 hardcoded hex), and the hardcoded remainder was mostly *intentional* (traffic-light `#ff5f57/#febc2e/#28c840`, brand marks) or a handful of status accents. Several components (Sidebar, FileTree) referenced tokens like `var(--danger, #e06c75)` that **nobody had ever defined**.

So the migration's stated premise, "untokenized components block light mode", was already largely false. Light mode came almost free: define the 3 anticipated status tokens (`--danger`/`--warn`/`--warn-strong`) in `tokens.css` for both themes (dark = the existing fallbacks, so dark stays byte-identical) and flip Light+ to `selectable: true`. The whole 5b–5e CSS-Modules migration was **dropped**; the light-mode payoff shipped with near-zero App.css edits.

## Why

A big CSS-Modules rewrite with no visual verification available (the browser tooling was blocked all session) is high-risk churn. The plan assumed the monolith was mostly hardcoded because it *looked* big and old, not because anyone measured. One `grep -o 'var(' | wc -l` vs a hex count reframed the entire remaining scope from "four risky phases" to "one small, safe pass."

## What to do next time

- Before scoping a migration justified by "the old code doesn't use X," **measure the actual coverage** (`var()` vs literals, per file). Size is not coverage.
- Treat `var(--x, fallback)` sites with an **undefined** `--x` as the real, cheap win, defining the token themes every such site at once with zero component edits (see [[gotcha_var_fallback_tokens_silently_hide_un_themed_values]]).
- Keep the file-split / CSS-Modules reorg as *optional organizational polish*, decoupled from the feature (light mode), so the feature isn't held hostage to churn.

See [[concept_design_token_system]] and [[adr_ui_config_system]].
