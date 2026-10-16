---
summary: sidebar groups a GitHub stack's local layers off the PR the row shows, read on github.com only, never inferred from base branches
status: current
updated: 2026-10-16
source: "plan 'GitHub stacked PRs grouped in the left sidebar' (personal/tori, branch `github-stacked-pr`, gettori/tickets#15); commits bec432f6, 3403e198; `src-tauri/src/forge/github.rs:477`, `src-tauri/src/forge/github.rs:884`, `src/panels/LeftSidebar/stacks.ts:11`, `src/panels/LeftSidebar/LeftSidebar.tsx:2820`, `src/panels/LeftSidebar/SidebarRows.tsx:268`"
---

# Native stacks are read, never inferred

GitHub's native stacked pull requests decide which branches are layers of one stack and in what order. Tori reads that answer off each pull request and draws the local layers of one stack as a single group in the project card, top layer first, with the trunk at the foot like GitHub's stack map. It never works a stack out from base branch chains.

## How it works

- **Data.** `stack { number size baseRefName }` and `stackEntry { position }` ride the `u{i}` and `e{i}` aliases of the batched poll, appended only when the forge is `versioned` (github.com) (`github.rs:884`, parsed in `stack_from_graphql` at `github.rs:477`). The result is `PullRequest.stack: PrStack | null` with `number`, `size`, `position` (1 is nearest the base) and `baseRef` (the stack's landing branch). `size` counts merged layers and layers nobody has locally, and merged pull requests keep their stack and position.
- **Stack numbers share the pull request counter** (stack 476 holds PRs 469, 475, 477 on github/gh-stack), so the header never shows the number: beside `#475` it would read as one more pull request (`SidebarRows.tsx:268`).
- **Grouping is pure.** `groupStacks` (`stacks.ts:11`) groups only when two or more layers are local, sorts members by position descending, and puts the group where its top layer was, so nothing else moves. It runs on the units `groupAttempts` left flat, so a fan out attempt that is also a layer stays in its attempt group.
- **Off the PR the row shows.** The grouping key is `shownPr` (`LeftSidebar.tsx:2820`), which goes through the same `unitChip` as the row's second line. A merged PR that `prRelation` calls unrelated therefore groups the branch with nobody, exactly as it puts no line on it.
- **The card's entry list is `BranchUnit | number`.** A stack stands in as its number, which `For` keeps by value, so a poll tick that rebuilds the group objects does not rebuild the rows. `stackGroupNode` looks its group up by number on every read. A group counts as one entry against `BRANCH_CAP`, and a selected layer keeps its group shown.
- **Disclosure is inverted.** The `s:` key in the persisted expanded set means collapsed, so stacks start open while the set keeps its one meaning of "changed from the default". Only `navigateTo` (links, notifications) clears it; a tab focus select leaves a collapsed stack shut, the same as it leaves a collapsed project.
- **The trunk row** is an inert `.attemptNode`, which is what ends the nested rail on it.

## Why it is this way

Inferring stacks from `baseRef` chains was rejected: it is a guess, and it flaps at the worst moment, when a lower layer merges and GitHub retargets the ones above. Ghost rows for layers with no local branch were rejected because they need `stack.entries` (more query cost) and a row type that is not a unit; the `n/size` marks and the header's count already show the gap. A lone local layer stays flat because a group of one has nothing to gather.

## Related

- [[concept_forge_rate_budget]] - the batch the stack fields ride
- [[concept_a_finished_pull_request_is_kept_by_relation]] - why an unrelated merged PR groups nothing
- [[gotcha_a_github_com_only_graphql_field_fails_the_whole_ghes_batch]] - why the fields are gated on `versioned`
- [[gotcha_the_sidebar_rail_is_a_variable_not_a_copy]] - how the layers nest one level in
- [[gotcha_a_referentially_keyed_for_over_recomputed_groups_resets_its_children]] - the remount the number stand-in avoids
