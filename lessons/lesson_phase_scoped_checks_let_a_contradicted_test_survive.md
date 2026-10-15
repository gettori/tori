---
summary: checks scoped to each phase's touched files missed tests an earlier phase broke elsewhere; run the full suite at each push
status: current
updated: 2026-10-15
source: gettori/tickets#24 phase contract, commit 2ffaa6b6; src/tabs/restoreCoexist.test.tsx; src/test/{interactiveTitle,tabStateWrites}.test.ts
---

# Phase-scoped checks let a contradicted test survive

## What happened

Phase 2 of #24 made a held terminal tab stay live and mount only when shown (`markHeld`). Two cases in `restoreCoexist.test.tsx` still asserted that every held tab mounts at once. Phase 8 added a Settings group heading and three tab-state writes, which changed counts in two guard tests. Each phase ran the Rust suite in full but only the vitest files next to what it touched, and these tests sat in other folders. All four failures surfaced only in phase 9, when `scripts/check.sh all` ran before the PR. Phases 2 to 8 had already been pushed.

## What we learned

A test that pins behaviour from a distance (a restore suite, a source-scanning guard) does not live next to the code that breaks it, so a scoped run never picks it up. The guards are built to fail on any new count, and that only helps if they run.

## How to apply

Run `scripts/check.sh all` before every push of a multi-phase branch, not only before the PR. When a check fails in a later phase, find the commit that broke it (here `git worktree add` at the previous phase's commit) before deciding whether the test or the code is wrong.

## Related

- [[adr_lazy_tab_attachment]]: the behaviour the stale test contradicted
- [[gotcha_a_source_scanning_test_in_the_file_it_scans_reads_itself]]: how the guard tests are built
