---
summary: Solid 2 rewrites an input's value when its attribute effect reruns, erasing typed text; read value through a memo
status: current
updated: 2026-11-23
source: plan "Solid 2 stage C: the switch to Solid 2.0" (personal/tori, branch `solid-2-stage-c-the-switch`, gettori/tickets#108), phase integrate-and-verify, commit 28263f33; `src/panels/Editor/PdfToolbar.tsx:34`
---

# An input's value resets when its attribute group reruns

Do not bind `value={s().a}` from a whole object read, or beside another attribute that changes while the user types. Why: an element's reactive attributes share one effect, and when it reruns `value` is written back even if unchanged, which erases uncommitted text. Granular store paths do not trigger it. Read the value through a `createMemo`, whose equality stops the rerun, or hold a draft signal fed by `onInput`. This erased typing in the PDF page, project command, TODO tag and debug value fields.

## Related

- [[gotcha_solids_on_re_runs_on_an_invalidated_dependency_not_on_a_changed_value]]: the same memo fix for a rerun on an equal value
