---
summary: searching an amended decision's own words missed a page stating the same retired stance differently, sweep the noun
status: current
updated: 2026-08-12
source: "Plan \"Amend adr_headless_primitives: wholesale adoption, Solid 2 gate\" (branch 95-ammend); ticket gettori/tori#95; `personal/tori/components/component_button.md:8`; commit skarif2/grimoire-docs@7bd9416"
---

# Sweep for the technology, not the policy wording

## What happened

Amending [[adr_headless_primitives]] from per-component on-demand adoption to wholesale meant finding every page that still asserted the old position. The obvious sweep was the policy's own words (`on-demand`, `not migrated`, `per-component`), which returned two sites: the ADR body and the `index.md` entry. Both were fixed and the amendment looked complete.

A third page carried the same superseded decision in wording the sweep could not match. `component_button.md` said "no component library was pulled in (Kobalte stays deferred for the hard widgets: dialogs, menus, tooltips)". Not one of the searched phrases appears in it, yet it states the retired policy more concretely than the ADR did, and it is the page a reader reaches first when asking why `Button` is hand-rolled. `grep -rln 'Kobalte'` found it immediately: four hits, not two.

## Why

A policy is written once in the page that decides it, and paraphrased everywhere it is applied. The deciding page uses the abstract vocabulary ("per-component and on-demand"); the applying pages use the concrete consequence ("no component library was pulled in", "stays deferred"). Searching the abstract vocabulary therefore finds the decision and misses its restatements, which is exactly backwards, because the restatements are what most readers actually encounter.

The technology name survives this paraphrasing. `Kobalte` had to appear in any sentence about Kobalte adoption, whatever stance that sentence took.

## What to do next time

When amending a decision, sweep on the **noun the decision is about** (the library, the service, the file format), not the sentence the decision used. Run it before writing the amendment, so the sweep shapes the scope rather than validating it afterwards.

Corollary for plans: a Context bullet claiming "only N places carry this" is a claim to attack, not a finding to trust. State the pattern that produced the number so the narrow pattern is visible, and prefer the widest cheap sweep over the precise one. Here the difference between the two greps was the difference between an amendment and a silent contradiction, which is the thing the ticket existed to prevent.

## Related

- [[adr_headless_primitives]], the decision amended, whose Amendment section records the superseded clause
- [[component_button]], the page the narrow sweep missed
- [[lesson_grep_the_installed_dep_before_wiring_a_binding]], the same failure in the other direction: a ticket premise that a wider grep would have falsified before any work started
