---
summary: flag parity across tools is a claim about behaviour, not spelling, run each binary against a fixture before trusting it
status: current
updated: 2026-08-01
source: "Search panel v2: toggles, ignored files, replace-in-files (personal/tori, branch `wave-1-2`); Phase 1; `src-tauri/src/search.rs:345` (`run_rg`), `src-tauri/src/search.rs:383` (`run_git_grep`); PR #81; issue #11"
---

# Prove flag parity by running the tools, not by reading their flags

## What happened

The ticket was "add search toggles", and the plan's first draft mapped each toggle onto each of the three grep backends by matching flag names: `-w` for whole word, `--glob` for include/exclude, drop `--exclude-standard` for ignored files. Every mapping read correctly. An adversary pass ran the actual binaries against fixtures and refuted three of them:

- `rg -w` matches `+foo` and `.env`; the `\b(?:pat)\b` the Rust side would use matches neither. Two matchers, two answers, and the disagreement lands exactly on the offsets a replace would write at.
- `rg --glob 'src/**'` returns matches with a relative search root and **nothing** with an absolute one. The plan's include field would have shipped silently broken on the primary backend.
- Dropping `--exclude-standard` does not reach ignored files at all: `git grep --untracked` honours `.gitignore` by default, and the opt-out is the separate `--no-exclude-standard`. This one survived into implementation and was caught only by its own task's test failing.

A fourth, `--max-count`, turned out to be per file rather than a total, so it never was the result cap the old code implied it was.

## Why

A flag's name and its manual page describe intent; parity is a claim about *behaviour*, and behaviour is what differs between independent implementations of "the same" feature. Reading two tools' documentation cannot detect that ripgrep's `-w` is implemented as a wider construct than a `\b` wrapping, because both documents say "word boundary" and both are telling the truth about what they meant.

The mappings were also mutually confirming in the worst way: each looked right in isolation, and none of them fail loudly. A silently-broken glob returns zero results, which reads as "no matches" rather than as a bug, and a non-functional ignored-files toggle returns exactly the results it would have returned anyway.

## What to do next time

When a plan claims an option will behave identically across separate implementations, execute each binary against one shared fixture and diff the results *before* writing the task. Three commands in a scratch directory settled all four questions here, and each refutation changed the plan's structure rather than its wording.

Two specific habits fall out. Prefer one implementation as the source of truth and demote the others to pre-filters, so parity becomes a property of the design rather than a matrix to maintain, see [[concept_canonical_matcher]]. And when a mapping cannot be made to work at all, report the gap in the wire format so the UI can disable the control, rather than documenting it in a code comment no user reads.

## Related

- [[concept_canonical_matcher]] - the design the refutations forced
- [[gotcha_rg_w_is_wider_than_b_pat_b]] - the trap this hardened into
- [[component_search_panel]] - where the backends live
- [[lesson_grep_the_installed_dep_before_wiring_a_binding]] - the same mistake about a dependency's contents rather than a binary's behaviour
- [[lesson_probe_the_capability_before_building_its_control]] - the same rule applied to a harness capability
