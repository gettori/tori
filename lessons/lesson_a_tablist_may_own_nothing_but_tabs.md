---
summary: every shape making a tab close button legal and reachable trips another axe rule, so only the keyboard path stays live
status: current
updated: 2026-10-05
source: "Plan \"Tab and OverflowTabBar onto Kobalte Tabs\" (personal/tori, branch `111-tab-and-overflow-tab-bar`, issue #111, fixing #115); `src/components/Tab/Tab.tsx`, `src/components/Tab/Tab.test.tsx`"
---

# A tablist may own nothing but tabs, so a close button cannot be announced

#115 said the close button nested inside `<button role="tab">` fails axe's `nested-interactive`, and the obvious fix is to move it out and make it a sibling. That fix does not exist. Moving it out trades one violation for another, and every shape that clears both drops the button out of the accessibility tree entirely.

## What was actually tried

Three shapes, measured with axe rather than reasoned about:

1. **Close inside the trigger, interactive** - `nested-interactive`. This is the shipped state #115 named.
2. **Close beside the trigger, labelled** - `aria-required-children` on the tablist: "Element has children which are not allowed: `button[aria-label]`". ARIA gives `tablist` a required-owned-elements list of exactly `tab`, and axe enforces it.
3. **The same, wrapped in `role="presentation"`** - identical failure. This is the part worth remembering: **axe reads straight through a presentational wrapper to the element underneath.** A wrapper hides the wrapper, not its contents.

What cleared the scan was `aria-hidden` on the sibling button, plus `tabindex="-1"`. Not "the close button is now correct" - "the close button is now invisible to a screen reader."

## The rule under it

An interactive control that is not a `tab` has nowhere legal to live inside a tablist. Nesting it breaks the widget; placing it beside the tab breaks the ownership; hiding it removes it. Composite widget roles with required children (`tablist`/`tab`, `listbox`/`option`, `list`/`listitem`, `menu`/`menuitem`, `tree`/`treeitem`) all behave this way, so a per-item action button is a general problem, not a tabs problem. The composer's stash menu hit it again: a discard button beside each `option` failed `aria-required-children` on the listbox, and it shipped as an `aria-hidden` x inside the option with Backspace as the keyboard discard ([[concept_prompt_stash]]).

## What to do instead

**Duplicate the affordance on the keyboard and hide the pointer one.** Delete or Backspace on the focused tab fires the close, and the button is `aria-hidden`. The function stays reachable; only the redundant control leaves the tree. This is also what the strips wanted for an unrelated reason: one tab stop per strip rather than two per tab.

Two things fall out of it, both of which cost time if you find them later:

- **A hidden button needs no name.** `closeLabel` was going to become a *required* prop; it was deleted instead. A name on an `aria-hidden` element is dead markup, and keeping it "for the tests" is dishonest markup. Tests moved to a `data-tab-close` attribute.
- **Sibling placement pays off elsewhere.** Because the close is a sibling and not a child, a click on it has no `role="tab"` ancestor. [[component_overflow_tab_bar]] uses exactly that to tell a close apart from a tab selection when guarding Kobalte's self-heal, which would otherwise have opened a different file every time you closed the active tab.

## Verify it, do not reason about it

Every one of the three shapes above looked plausible on paper. The answer came from mounting each inside a real `Tabs.Root`/`Tabs.List` and running [[concept_axe_accessibility_gate]] over it, which took minutes. The scan is also the only thing that catches the second failure mode: a fix that clears the rule you were chasing and trips a different one on the same element.

## Related

- [[component_tab]] - where this landed.
- [[component_overflow_tab_bar]] - the strip, and the second use of the sibling placement.
- [[concept_axe_accessibility_gate]] - what found #115 and what settled the argument.
- [[concept_prompt_stash]] - the same trap in a listbox, solved the same way.
