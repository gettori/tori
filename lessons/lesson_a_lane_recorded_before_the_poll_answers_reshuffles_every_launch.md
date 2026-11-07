---
summary: recording a branch's lane before the forge answered made every launch move all branches to the top of their lanes; keep it pending
status: current
updated: 2026-11-07
source: plan "Sidebar lanes, custom groups and branch line controls" (branch left-sidebar-customization), phase 5 self-review; src/panels/LeftSidebar/LeftSidebar.tsx:3374, :4286, :4326
---

# A lane recorded before the poll answers reshuffles every launch

## What happened

The sidebar records the lane each branch was last seen in, so a branch whose PR moves it lands at the top of its new lane. At launch, before the first forge poll, `prChildState` saw no status and answered "No PR", so every branch was drawn and recorded in Working. When the poll landed, every branch with a PR "arrived" in its real lane and was moved to its top. The user's order inside each lane was rewritten on every launch.

## What we do now

`unitChild` answers `pending` while the forge chip is `hidden` or `unknown` (`LeftSidebar.tsx:3374`). A pending branch is drawn in its last recorded lane (`placeOf`, `:4286`), and `lanesOnScreen` (`:4326`) skips it, so its record is kept until the forge answers.

## The rule

A "no data yet" answer must not be stored as a fact. Anything that compares the present against a remembered state needs a third value for "not known", or the first read after a cold start reads as a change.

## Related

- [[concept_sidebar_arrangement]]
