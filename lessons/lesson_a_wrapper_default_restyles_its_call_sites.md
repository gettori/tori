---
summary: a new wrapper defaulted its label size and color, silently restyling every row that had already made its own choice
status: current
updated: 2026-08-15
source: "plan \"Checkbox, Switch and Slider wrappers and control migration\" (personal/tori, branch `107-checkbox-switch-slider`, issue #107); `src/components/Checkbox/Checkbox.module.css`, `src/components/Switch/Switch.module.css`, `src/components/Slider/Slider.module.css`"
---

# A wrapper's "sensible default" restyles every call site that already chose

## What happened

The new `Checkbox` and `Switch` wrappers styled their label the obvious way:

```css
.label {
  color: var(--fg-default);
  font-size: var(--tori-text-sm);
}
```

Read alone, that is a reasonable default. Read against the call sites, it was a silent restyle of all of them. Every row these controls were about to be dropped into had already made that choice on its own class: `.wtCheck` in the dialogs sets `--tori-text-lg`, `.amendRow` and `.cumulativeToggle` and `.readsToggle` in the panels set `--fg-muted` at `--tori-text-md`. Those classes are passed to the wrapper as `class` and land on the *root*, so they style the row, while the wrapper's own `.label` rule wins on the label element inside it. The migration would have shipped a dozen controls whose text was the wrong size and colour, against a plan that explicitly ruled out visual change.

The fix was to inherit rather than declare:

```css
.label {
  color: inherit;
  font-size: inherit;
}
```

The control's box or track belongs to the wrapper; the words beside it belong to the caller's row.

## Why no test caught it

Nothing here is a behaviour. The suite ran 3773 tests green with the bug in place, because jsdom asserts nothing about computed style, and CSS Modules mean even a class-name assertion would have passed. Both the wrapper suites and the migrated call sites' suites were querying roles and values, which is what they should do. This class of regression is invisible to the whole test strategy, so it has to be caught by reading the diff against the CSS the call sites already had.

## The general shape

When a wrapper absorbs markup that call sites used to own, ask which declarations those call sites were **already making** about the absorbed part. Anything on that list is not the wrapper's to default: it either inherits, or it takes a prop. A default is safe only for a property no call site had an opinion about.

The tell is a wrapper that takes a `class` for layout: if callers style the row, they were probably styling its contents too.

## Related

- [[component_boolean_controls]] — the family this was found in
- [[gotcha_a_component_that_sets_its_own_classlist_clobbers_a_callers_classlist]] — the same collision one level up, on the class attribute rather than on inherited properties
- [[component_popover]] — where the "wrapper owns the surface, caller owns layout" split is stated
- [[lesson_a_wrapper_is_a_control_until_told_otherwise]] — the other way a wrapper's defaults surprise its callers
