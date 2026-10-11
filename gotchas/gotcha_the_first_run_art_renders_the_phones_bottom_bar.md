---
summary: the desktop first-run intro renders the phone's BottomBar, so a new prop breaks the root tsc, not the mobile one
status: current
updated: 2026-10-12
source: "Review inbox plan (branch `phase-1-block-2`, gettori/tickets#32); commits fb28a0fb, 6fe8ba85, d95439d9; `src/panels/FirstRun/intro/art/Mobile.tsx`, `mobile/src/BottomBar.tsx`"
---

# The first-run art renders the phone's bottom bar

Do NOT trust a clean `tsc` inside `mobile/` after changing a phone component's props. `src/panels/FirstRun/intro/art/Mobile.tsx` mounts `mobile/src/BottomBar.tsx` (and `Root`) with stub props, so only the root `tsc`, which the pre-push hook runs, sees the missing prop. Run both, and add the stub to the intro art.

## Related

- [[component_review_inbox]] where the Inbox props first tripped it
