---
summary: a plan written from reading the code can still name a mechanism the code forbids, caught by a guard or test in hand
status: current
updated: 2026-08-28
source: "Feature lifecycle, member management and repair (personal/tori, branch `feature-workspace`, issue #159) - all five phases - commits 774704d, ef3779b, ede61ff, 70756f3; and again in #160 phase 3, same branch"
---

# A plan names a mechanism the code forbids

## What happened

The plan for #159 was written after reading the code it was going to change, was red-teamed before being saved, and still specified a mechanism the codebase rejects **four separate times**. Each was caught during execution, by a guard or a test rather than by re-reading the plan.

- **Phase 1: "Remove disabled with that text as its title."** `src/test/interactiveTitle.test.ts` refuses a native `title=` on a `role="menuitem"`: hover-only, unstyleable, invisible to the keyboard. `MenuRow` already had `refusing` (aria-disabled, still arrow-reachable, does nothing) and `describedBy` for exactly this case. The right change was a `note` on `MenuItem` drawn under the label, not an exemption.
- **Phase 2: "one `ProjectKind::Worktree` unit per non-main entry."** As written that claims every linked worktree, including one sitting *beside* its repo, which is a project in its own right and would list twice. The rule had to be containment, not non-main.
- **Phase 4: "show dirty / unpushed tags in `ConfirmDeleteSpace`'s shape."** `ConfirmDeleteSpace` gates on typing the space name, which is wrong for a reversible record delete. What was wanted was its `delEntry` / `delTag` markup, not the component.
- **Phase 5: "pre-checked existing members are disabled."** `RepoChecklist`'s `exclude` prop removes existing members from the list entirely. The task also said "verify: test passes against the current dialog with no source change", so the honest test asserts what the code does, and the task text was the thing to amend.

### And once more, one ticket later (#160 phase 3)

- **"`kind` comes from the unit whose `folderPath` equals the member's `worktreePath`."** The task even said why: never `branchUnits[0]`, because #159 made a plain repo list its contained Feature worktrees. It named the right hazard and then walked into it from the other side. Those listed worktrees carry `kind: "worktree"`, so matching the *member's* worktree answers `worktree` for a plain repo, which is the opposite of what the same task's `verify:` demanded and would have offered a `.shared/` folder that is not there. What separates the two layouts is whether a unit sits at the **project's own** folder: a plain repo has one, a bare container has none. Still matched by `folderPath`, still never by position.

The tell this time was inside the task itself. The mechanism and its verify disagreed, and the verify was right. A task that states both is cheap to check before writing any code, and nobody checked.

## Why

A plan is written at one remove from the code: from grepping, from a component's doc comment, from what a mechanism is *called*. Every one of these four is a case where the name was right and the mechanism behind it was not. Three of them were caught by something that already existed and already knew better than the plan: a source-scanning guard, a component's own docs, a prop signature.

## What to do next time

- **When a task's mechanism fails a guard, change the mechanism, not the guard.** Adding an entry to a named-exemption list is almost always the wrong repair; the guard exists because the mechanism is a defect ([[concept_named_exemption_guard]]).
- **Amend the task text in the plan when you deviate, in the same edit as the tick.** All four are recorded in their phase's `Notes:` with the wording change beside the reason, so the plan and the code do not end the ticket disagreeing. That is what makes end-of-ticket distillation from `Notes:` trustworthy.
- **A task that says "no source change" is a claim about the code, and can be wrong.** Test what the code does and amend the claim; do not quietly change the source to match the plan.
- **When a task states a mechanism *and* a verify, read them against each other first.** The fifth one contradicted itself on the page, before any code was in front of anyone.
- **Red-teaming the plan did not catch any of these.** The adversary pass found scope and ordering holes; it did not know which mechanisms the repo forbids. That knowledge lives in the guards and the component docs, which means it only surfaces once the code is in front of you.

## Related

- [[concept_named_exemption_guard]] - the guard that caught the first one, and why exempting is the wrong repair.
- [[component_menu]] - `refusing` and `describedBy`, which were already the documented answer.
- [[lesson_a_named_exemption_can_be_wrong_and_still_pass]] - the failure mode on the other side of the same guard.
- [[component_feature_store]], [[component_feature_list]], [[component_project_discovery]] - what the four phases actually built.
