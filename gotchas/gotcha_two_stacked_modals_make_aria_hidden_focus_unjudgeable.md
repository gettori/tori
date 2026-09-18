---
summary: two stacked dialogs make aria-hidden-focus land under incomplete since jsdom cannot judge reachability through a stack
status: current
updated: 2026-08-12
source: "plan \"Migrate the seven simple dialogs onto Dialog\" (personal/tori, branch `99-migrate-seven-dialogs`, issue #99); `src/components/Dialogs/stackedDialogs.test.tsx:134`"
---

# Two stacked modals make `aria-hidden-focus` unjudgeable

Do NOT expect a plain `expectNoAxeViolations(document.body)` to pass while two dialogs are open. Why: modality aria-hides the covered panel while its buttons stay focusable, and jsdom cannot decide whether they are really reachable, so the rule comes back under `incomplete` - which this harness fails on by design (see [[gotcha_axe_files_what_it_cannot_judge_under_incomplete_not_violations]]). Disable that one rule for that one assertion with the reason in place rather than globally in `src/test/axe.ts`, since it is judgeable everywhere except in a stack. Focus and dismissal themselves survive the stack; it is only the rule that cannot answer.
