---
summary: a today fixture built as an offset back from now lands in Yesterday near midnight, since bucketing is by local midnight
status: current
updated: 2026-07-31
source: Session navigation moves to a History dropdown (branch `navigation`, phase 6); `src/panels/Terminal/HistoryPanel.test.tsx`, `src/utils/sessionBuckets.ts`; commit 61eb767
---

# A midnight crossing makes an offset from now fixture land in Yesterday

Do not build a "today" fixture as an offset back from now when the code buckets by **local midnight**. Any run between 00:00 and 01:00 puts it in Yesterday and the test fails on the clock rather than on the code. Why: `sessionBuckets` splits eras on local midnight, not on rolling 24-hour windows. Use `now()` itself, which is Today by construction.
