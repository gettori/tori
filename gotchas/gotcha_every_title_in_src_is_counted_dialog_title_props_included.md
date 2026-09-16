---
summary: any title= under src must be registered in interactiveTitle.test.ts KEPT with a reason, and the scan reads comments too
status: current
updated: 2026-09-03
source: "Features phase 1 (#153), branch `feature-workspace`; `src/test/interactiveTitle.test.ts:187`; commit 514787a; _2026-08-25_; extended by plan \"Jobs: transient command terminals leave the tab model\" (branch `bugfix-260903`), Phase 2; `src/panels/Jobs/JobTray.tsx`; commit `3a9f882`; _2026-09-03_; that file was deleted in `d4a59d3` and its `KEPT` entry with it, which is itself the rule: an entry outliving its file fails the guard as loudly as an unregistered `title=`"
---

# Every title= in src is counted, dialog title props included

Do NOT add a `title=` anywhere under `src/` (a `<Dialog title=` or `<PromptModal title=` prop as much as a hover title on a span) without registering the file in `src/test/interactiveTitle.test.ts` `KEPT` with a reason, and moving the raw-element pins (`div`/`span`/total) when the element is lowercase. Why: the guard is a named-exemption count, and it only runs in the full suite; Phase 1 of #153 ran a subset and shipped four unregistered titles that Phase 2 found. The scan is **textual over raw source**, comments included: a code comment that mentions `title=` (even one explaining a removal) trips the guard exactly as a live attribute would, so the fix has to phrase the comment around the string, not just remove the attribute.
