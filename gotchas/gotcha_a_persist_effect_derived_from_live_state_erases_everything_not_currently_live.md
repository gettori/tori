---
summary: a persist effect serializing only the live subset writes an empty store on first render, wiping every unopened tab
status: current
updated: 2026-07-20
source: "Daily-driver polish: unseen badge, copy actions, tab peek, restore (personal/tori, branch `main`); Phase 2; `src/utils/tabPersist.ts` (`mergeStore`), `src/panels/Terminal/Terminal.tsx` (persist effect, `touched`); see [[component_tab_restore]]"
---

# A persist effect derived from live state erases everything not currently live

Do NOT write a localStorage store from an effect that serializes only the *currently live* subset (`saveTabs(toStore(open(), ...))`). Why: the effect runs on first render, when the live set is still empty, so it writes `{}` and wipes every key the store held — including workspaces the user has not visited yet this run. It is invisible within the run (an in-memory snapshot taken during setup still serves the restore offer), so it only bites on the **next** launch: open Tori, quit without opening a tab, and last run's tabs are gone forever. The fix is a merge, not a replace: carry through every key this run has not touched, and track a `touched: Set` of keys that *have* had live entries, so a key is only erased by going empty after this run actually populated it. That same `touched` rule is what makes "current truth overwrites a declined restore offer" work. Caught by self-review, never by a test or by using the app, because the damage is one launch removed from the cause.
