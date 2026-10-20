---
summary: an open PR's number is rose asked, orange changes, red conflict, green approved, else muted; the trunk's PR is a release
status: current
updated: 2026-10-21
source: "Browser: open in the browser when the server starts, gettori/tickets#90, sidebar follow-ups (branch `browser-extension`, commits b9d538b5, 160549b7); `src/utils/forgeTypes.ts` (`prTone`, `releaseShows`), `src/panels/LeftSidebar/BranchLine.tsx`, `src/utils/defaultBranch.ts`"
---

# The PR number is coloured for what it needs

A branch row's second line no longer carries a review glyph. The number itself says what the open pull request needs from you, and everything else on the row stays grey, so a glance down the column finds the few rows that want something.

## How it works

- **`prTone(status, asked, conflicting, release)`**, first match wins: your review is asked (rose, `--status-needs-you`), changes requested (orange, `--attention-fg`), a conflict with the base (red, `--danger-fg`), approved (green), otherwise muted. `asked` comes from `requestedReviews`, so a re-request after your changes requested beats the verdict still standing on the PR.
- **Draft and closed** are muted and told apart by their glyphs; merged stays purple.
- **The conflict glyph steps aside** on any row with an open PR, and the line's tooltip names the files. A row without a PR keeps it.
- **The row's status bubble drops PR attention** (`noPrAttention`), since the number already says why. A collapsed project and a space tile keep it.
- **The default branch's PR is a release** (`release`, from `defaultBranchOf`, asked once per repo): the line reads `-> stage #8020` under `GitPullRequestArrow`, approved stays muted, a merged or closed one shows for a day (`releaseShows`), and the row never takes the finished look.
- Storybook: `BranchLine/Tones` and `BranchLine/Release` hold every state.

## Why it is this way

Colour on every number had stopped carrying information: every open PR was green. Moving the verdict into the number's colour freed the first line, and red now means one thing. A release from the trunk is routine, so it only lights up when it needs you.

## Related

- [[concept_a_finished_pull_request_is_kept_by_relation]]: which finished PRs a branch keeps at all
- [[component_pull_requests_panel]]: the panel's chips still use the old state colours
