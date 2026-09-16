---
summary: an exact occurrence count proves quantity not classification, so five files sat under a wrong exemption reason unseen
status: current
updated: 2026-08-13
source: "plan \"Tooltip primitive and the `title=` sweep\" (personal/sway, branch `102-tooltip-primitive`, issue #102), phases 4 and 5; `src/test/interactiveTitle.test.ts`; commits a23d8f4, dbfa12a"
---

# Read every exemption's reason at close, not just its count

## What happened

#102's guard held 41 exempt files to an exact `title=` count each, and stayed green for four phases. Five of those entries were filed under the wrong reason the whole time.

`ModelPicker` and `ModeSelector` were listed as "the `title` prop of a Settings `Group`/`Picker` — a section heading". They are not: `Picker` forwards its `title` prop to a real `<button>`, so those were three interactive sites hiding in the *kept* list. The word "Picker" in the shared reason string is what made it read correctly. They only surfaced in phase 4 because renaming `Picker`'s prop broke the call sites.

`CallsPanel`, `OutlinePanel` and `SessionPanel` were listed as truncation on an unreachable element. All three are `div`s with an `onClick` — clickable rows with no keyboard path, a category the guard already had a name for. They surfaced in phase 5 only because the closing task required reading each surviving reason against its site.

## Why

An exact count proves **quantity, not classification**. Every check the guard ran — is this file listed, does the number match, is there a reason at all, is the reason longer than a stub — passes just as happily on a wrong reason as a right one, because none of them looks at what the occurrence actually *is*. The reasons were plausible, which is worse than being absurd: a wrong reason that reads correctly is invisible on every future scan of the file.

This is the complement to [[concept_named_exemption_guard]]'s strength. Failing open catches the file nobody listed. It cannot catch the file somebody listed for the wrong reason, and nothing automatable can, short of encoding the classification the guard deliberately refuses to do.

## What to do next time

- **Budget a read-through of the ledger as a task, at close.** Not a re-run: an actual pass over each entry against the code it exempts. In #102 this was the closing task and it found three entries in one sitting.
- **Reach for a type before a ledger.** #102 finished by making `title` a type error on the four tooltip-bearing components, which retires that whole class of wrong entry — `tsc` passing is proof no site of that shape survives. A ledger is the backstop for what a type cannot reach, not a substitute for reaching it.
- **Treat a shared reason constant as a claim about every file citing it.** Naming the reasons is what makes the audit possible at all, but a constant whose text happens to name a component (`Group`/`Picker`) will pull unrelated files under it. Prefer reasons that describe the *site* — "a non-interactive span", "a div with an onClick" — over ones that name a component.
- **When a category exists, assert its size.** #102 ended by pinning the clickable-row count at ten, so "we deliberately left these alone" stops being true the moment the number moves.

## Related

- [[concept_named_exemption_guard]] — the mechanism, and its documented limit
- [[lesson_a_rule_that_matches_nothing_passes_every_guard]] — the sibling: a rule that matches nothing
- [[lesson_a_gate_that_cannot_fail_is_not_a_gate]] — the sibling: an assertion that cannot go red
- [[concept_tooltip_trigger_is_the_control]] — the sweep this ledger tracked
