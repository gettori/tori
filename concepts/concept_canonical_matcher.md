---
summary: project search runs three backends only to narrow lines, while one compiled regex alone decides every match and offset
status: current
updated: 2026-08-01
source: "Search panel v2: toggles, ignored files, replace-in-files (personal/sway, branch `wave-1-2`); all four phases; `src-tauri/src/search.rs:126` (`canonical_pattern`), `:282` (`finalize`), `:585` (`expand_at`); PR #81; issue #11"
---

# One canonical matcher, three candidate finders

Project search runs on three interchangeable backends (`rg --json`, `git grep`, a plain recursive `grep`), and they do **not** agree about what a match is. Rather than configure each one to imitate the others, Sway inverts the arrangement: a single `regex::Regex` compiled from the user's options is the only thing that decides whether a line matched and where the match sits, and the three backends are demoted to narrowing down which lines are worth showing it.

The payoff arrives at replace time. Replace compiles the same pattern from the same `(query, options)` and re-finds the match at the offset the panel is displaying, so the span you approve in a preview and the span that gets written are the same span **by construction**, not by two implementations happening to agree. Parity became a property of the design instead of a matrix to maintain.

## How it works

`canonical_pattern` (`search.rs:126`) folds the panel's options into one pattern string: a literal query goes through `regex::escape`, whole-word wraps the result in `\b(?:…)\b`, and case-insensitivity is the inline flag `(?i)` rather than a per-backend `-i`. That string compiles once, and its compile error is what the panel shows for an invalid regex.

Each backend then contributes only `(path, line, text)` candidates:

- **ripgrep** is handed the canonical pattern as a plain `-e` argument and never `-w`, `-F` or `-i`, because those are a second matcher. It runs with `current_dir(root)` against `.`, never an absolute path (see the glob trap below), and keeps `--max-count max + 1` purely as a coarse bound on how much JSON one pathological file can emit.
- **`git grep` and `plain_grep`** get a *literal* `-F` pre-filter only: the longest run of characters the pattern requires verbatim, computed by `longest_literal` (`search.rs:143`), which bails to `None` on alternation, groups and classes because a literal inside one branch is not required by the pattern as a whole. With no literal the pre-filter is the empty string, which matches every line, and the regex does all the selecting. POSIX ERE is never generated.

`finalize` (`search.rs:282`) is the single funnel: it applies the include/exclude globs, runs the canonical regex over each candidate line to confirm the match and derive its spans, and only then applies the result cap.

**The offset boundary is crossed twice, in opposite directions.** Spans leave Rust as UTF-16 code units (`submatches_utf16`, `search.rs:195`) because the consumer indexes JavaScript strings; they come back as UTF-16 and are converted to byte offsets within the addressed line (`utf16_to_byte`, `search.rs:540`) before anything is written. Line text is normalised by stripping only `\r\n`, never other trailing whitespace, so a `\s+$` match cannot end past the text the UI renders.

**Expansion is why a span is re-found rather than trusted.** `$1` and `${name}` need a `regex::Captures`, which exists only as a by-product of matching, so `expand_at` (`search.rs:585`) re-runs the regex at the given offset and requires the match to start and end exactly there. The capture the panel needs and the verification the write needs come from the same call.

Because backends differ in what they can honour at all, `SearchResult` carries the `backend` that ran and an `unsupported` list, so the panel disables a control rather than showing one that does nothing.

## Why it's this way

The alternative, letting each backend match natively and reading its reported offsets, fails on a concrete case: `rg -w` matches `+foo` and `.env`, where `\b(?:pat)\b` matches neither. Search would then find a match at an offset that the Rust side, which performs the replace, does not agree is a match at all. The failure surfaces as a replace that silently skips, or worse writes at a span no matcher endorses, and only for patterns whose edges are non-word characters (`.env`, `-flag`, `$var`, `@media`), which is ordinary code-search vocabulary rather than an exotic case.

The same reasoning forces the literal pre-filter. Translating a `regex`-crate pattern into ERE for the grep fallbacks would be a second matcher wearing a disguise: the dialect varies by platform, and a pattern valid here can make grep exit 2 outright. A literal pre-filter can only ever over-fetch candidates, never drop a real match, and over-fetching is free once `finalize` verifies everything anyway.

It also forces the preview to be computed in Rust rather than JavaScript. `RegExp` is a different dialect (`(?P<name>)` versus `(?<name>)`, `\p{…}` semantics, no `(?x)`), so a JS-side preview could render an expansion the write would not reproduce, and a preview that disagrees with the write is worse than no preview, because it is the thing the user approves.

Capping after verification rather than during parsing follows from the same funnel: a broad pre-filter can fill a 500-line budget with lines that do not match, leaving the panel showing a handful of results under a banner claiming they were capped.

The cost is honest and bounded: a pattern with no literal run makes the no-ripgrep, no-git backend read every line of the project, and the whole candidate set is held in memory before the cap applies. Streaming with an early kill was left out of scope.

## Related

- [[concept_fail_closed_replace]] - the guard chain that stands on this, once a match becomes a write
- [[component_search_panel]] - the command and panel this governs
- [[gotcha_rg_w_is_wider_than_b_pat_b]] - the divergence that forced the inversion
- [[gotcha_an_anchored_glob_needs_a_relative_search_root]] - why rg runs from inside the root
- [[gotcha_git_grep_needs_no_exclude_standard_to_see_ignored_files]] - the ignored-files half
- [[gotcha_rg_max_count_is_per_file_not_a_total]] - why it is not the result cap
- [[gotcha_match_offsets_cross_to_js_as_utf_16_not_bytes]] - the boundary conversion
- [[lesson_prove_flag_parity_by_running_the_tools]] - how the divergence was found
- [[concept_fs_change_pipeline]] - the watcher that re-runs the search
