---
summary: adding aria-label to a tab whose text tests query by replaces its accessible name, breaking queries once counts show
status: current
updated: 2026-08-13
source: "Settings redesign: horizontal tab strip with per-tab search counts (personal/tori, branch `settings`, issue #91); Phase 3; `src/panels/Settings/Settings.tsx` (`tabName`); commit fe9a640; _2026-08-11_; extended by plan \"Tooltip primitive and the `title=` sweep\" (branch `102-tooltip-primitive`, issue #102); `src/test/interactiveTitle.test.ts`, `src/panels/Editor/Editor.tsx`; commit `51771df`"
---

# An `aria-label` on a tab replaces its accessible name

Do NOT add an `aria-label` to a control whose visible text tests already query by. Appending a match count to each Settings tab ("Editor, 1 match") replaced the accessible name outright, so every `getByRole("tab", { name: "Editor" })` written before the counts existed failed the moment a query was running — and only then, so the breakage is conditional on test state rather than on the test. The same edit put the count inside the tab's `textContent`, breaking helpers that read the label that way. Query the label span (`'[role="tab"] span'`) and anchor name lookups (`{ name: /^Editor/ }`). Why: `aria-label` reads as additive, and half a suite keeps passing.

**The exception is a tab with no text to replace.** An icon-only tab (self-closing, no children) has no visible name of its own, so `aria-label` is the only name it can have - the editor's right-panel mode tabs are the app's one instance. #102's guard forbids `aria-label` on any `tooltip=`-bearing `Tab` and exempts exactly that shape, which is checkable from the same JSX parser: self-closing means no children. This is also why `Tab` alone among the three controls does not backfill its name from `tooltip` ([[concept_tooltip_trigger_is_the_control]]) - doing so would rename every tab in the app to its full path.
