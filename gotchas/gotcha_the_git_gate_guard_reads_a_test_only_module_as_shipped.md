---
summary: no_git_starts_outside_the_gate treats text before the first #[cfg(test)] as shipped, so build test fixtures through git_in
status: current
updated: 2026-10-04
source: "Gate performance with deterministic budgets in tests (personal/tori, branch `determinstic-budget-in-tests`, gettori/tickets#6), Phase 2; `src-tauri/src/exec.rs` (`no_git_starts_outside_the_gate`), `src-tauri/src/perf_budgets.rs`"
---

# The git gate guard reads a test-only module as shipped

Do not write `Command::new("git")` in a module that is test-only because `lib.rs` declares it `#[cfg(test)] mod x;`. Build fixture repos through `exec::git_in` instead (tests trust every folder, so it runs). Why: the guard splits each file's text at its first literal `#[cfg(test)]` and calls everything above it shipped, so it never sees the gate in `lib.rs`, and an inner `#![cfg(test)]` does not match its string either.

## Related

- [[concept_perf_budgets]] - where it bit: the sidebar git fixture, which now subtracts its own spawns from the count
- [[gotcha_a_source_scanning_test_in_the_file_it_scans_reads_itself]] - another source scanner reading text more literally than the compiler does
