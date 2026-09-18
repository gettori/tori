---
summary: context menu rows that act on the same node and differ only by parameter collapse into one dialog with a mode picker
status: current
updated: 2026-07-12
source: Combine group create actions into one New dialog (personal/tori, branch code-mirror-6); `src/components/NewProjectDialog.tsx`, `src/components/Sidebar.tsx` group menu; sibling `src/components/InitGitDialog.tsx`
---

# Collapse related context-menu rows into one dialog with a mode picker

## What happened

The space context menu carried three separate create rows (New folder, Clone repo…, Bare + worktree…), each firing a chain of `askText` prompts. They collapsed into one **New…** row opening `NewProjectDialog`, whose segmented control picks the mode and reveals only the fields that mode needs. This is the third time the same move was made on this sidebar: `Remove branch` (Detach + Delete Branch) and `Initialize git` (git-init + bare) preceded it.

## Why

Several menu rows that act on the **same node** and differ only in a parameter are really one action with a mode. Splitting them multiplies rows, and the sequential `askText` chain hides the choices behind blind prompts (you cannot see the URL and name together, or switch your mind without cancelling). A single dialog makes the modes visible, shares validation, and lets fields be conditional (URL only for clone/bare). The menu shrinks and the flow becomes one confirm instead of a prompt cascade.

## What to do next time

When you find **2+ context-menu rows on one node that share a target and differ by a parameter or layout**, collapse them into a single row that opens one dialog with a **segmented/toggle mode picker** rather than adding another row or an `askText` chain. Mirror the established pair:

- `InitGitDialog` — a boolean layout toggle (normal vs bare).
- `NewProjectDialog` — a 3-way `.seg` segmented control (`folder | clone | bare`); always-on Name, conditional URL, name auto-fills from URL until hand-edited.

Keep the routing in the parent's `confirm*` handler (branch on mode: native invoke vs `runInTab` terminal tab), reuse the `.modal-*` / `.seg` chrome, and gate Create on per-mode validity. Prefer `aria-pressed` toggle buttons in a `role="group"` over a `tablist` without real tabs.

## Related

- [[component_context_menu]] — the sidebar menu this convention lives in (space **New…**, plain-dir **Initialize git…**)
- [[gotcha_clone_and_bootstrap_run_in_a_terminal_tab]] — why clone/bare route to a terminal tab, not a native invoke
