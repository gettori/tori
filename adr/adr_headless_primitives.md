---
summary: Kobalte supplies dialog, menu, tooltip and control behavior behind src lib, wrapped and styled only in src components
status: current
updated: 2026-08-12
source: Design-system discussion following the settings-redesign planning session (2026-08-11); ticket gettori/tori#93; no code yet, decision precedes first implementation; amended by gettori/tori#95 and gettori/tori#94
---

# Headless behavior comes from Kobalte, re-exported through `src/lib/`, styled only in `src/components/`

Tori's design system already owns the visual layer (tokens, roles, contrast gate, `/styleguide`); the missing layer was accessibility-correct component *behavior*: dialogs, menus and context menus, tooltips, toasts, popover, select and the native form controls (checkbox, switch, slider), tabs and toggle groups, and dismissal layering for stacked overlays. We adopt **Kobalte** (Solid-native headless primitives, WAI-ARIA APG per component) as that layer, consumed **only** through a `src/lib/` re-export module. Styled Tori components in `src/components/` compose those parts on design tokens via CSS Modules and expose Tori's own API (`ControlSize`, variants); app code imports `components/*`, never `lib/` and never `@kobalte/core` directly. A guard test (or lint rule) enforces the import boundary, in the same spirit as the `settings.rs?raw` scan tests. This is the same identity-vs-consumed-name split as [[lesson_split_identity_from_consumed_name]]: if Kobalte stalls, the swap edits `lib/` and a handful of wrappers, not the app.

Adoption is **wholesale**: every interactive primitive with a Kobalte counterpart moves behind `lib/`, as one program rather than one wrapper per consumer. This is the scope of gettori/tori#93, whose inventory (14 untested dialogs, 221 `title=` attributes, 8 context-menu consumers, two picker implementations) is what made a demand-driven rollout untenable: the a11y debt is already everywhere, so waiting for a consumer to ask only spreads the same pattern further. **Migrating:** the dialogs, `Menu` (onto DropdownMenu and ContextMenu), `Popover`, the toasts, `SegmentedControl` (onto ToggleGroup), `Tab`, the native form controls (select, checkbox, switch, slider), and the `title=` tooltips. **Staying native, deliberately:** `Button`/`IconButton` (43 consumers, no meaningful Kobalte counterpart), `Omnibox` (bespoke), `Resizer`, the visual components (`Icon`, `Chevron`, `SymbolIcon`), and the app widgets (`Toolbar`, `WindowControls`, `UpdatePill`, `ForgeChip`). Wrapped components are developed in **Storybook** (`storybook-solidjs-vite` framework + a11y addon, axe on every story, themed via a `data-theme` decorator through the theme resolver); the in-app `/styleguide` remains the theme/brand QA surface and is not ported.

## Considered Options

- **Ark UI** (rejected, narrowly): stronger maintenance backing (company-backed, Zag.js machines, monthly releases) but its Solid adapter wraps framework-agnostic state machines, a permanent indirection layer; the `lib/` boundary already hedges Kobalte's maintenance risk (community-run, 0.x).
- **Fully in-house** (rejected): `SegmentedControl` proves the team can execute APG patterns, but owning Combobox typeahead, Select keyboard models, and dismissal layers forever is undifferentiated work with the worst DIY a11y track record.
- **Styled component libraries** (rejected outright): would fight or duplicate the token system, and the major ones are React-only.

## Consequences

- Sequenced in waves, not by consumer demand: foundation first (the `lib/` boundary, Storybook, the axe gate), then the shared `Dialog` primitive (ShortcutSheet's focus-trap pattern generalized) and the rest of the high-traffic a11y debt (tooltips, context menus), then the controls (popover, toasts, select, checkbox/switch/slider, toggle group), then dedupe and the tail (icon grids, picker consolidation, tabs). A wrapper lands with its wave whether or not a surface has asked for it.
- Storybook enters the toolchain as a dev dependency (reuses the Vite config; `tokens.css` imported in preview); stories are written for wrapped components, not raw Kobalte parts, so the a11y addon audits Tori's actual composition.
- The import-boundary guard must land with the first `lib/` export, not after.

## Solid 2 gate

The primitives layer stays on `solid-js` 1.9. Solid 2.0 is a reactivity-core rewrite (lazy pull-based derivations, scheduled effects, `createAsync` replacing `createResource`, `solid-js/web` split into `@solidjs/web`), and the risk is semantic rather than syntactic: effect-timing changes alter behavior silently across 233 timing-sensitive test files. Migration work does not start until **all four** of these hold (tracked in gettori/tori#112):

- `solid-js` 2.x stable (was `2.0.0-beta.33` on the `next` tag when this gate was written)
- `@kobalte/core` ships a stable Solid 2 line (its peer range was `solid-js ^1.9.8`, no 2.x support)
- `vite-plugin-solid` 3.x stable (was `3.0.0-next`)
- `@solidjs/testing-library` 1.x stable (was `1.0.0-beta`)

Even then a branch spike runs first, cataloguing every test failure by class before a go/no-go. There is no partial adoption: the app and the primitives layer move together or not at all, because a split would put two reactivity semantics behind one `lib/` boundary.

## Related

- [[adr_premium_design_system]] — the visual identity this behavioral layer must not disturb
- [[adr_theme_palette_roles]], the token/roles system wrapped components style against, and the no-unused-surface philosophy this now follows only in the narrow form of the stays-native list
- [[concept_design_token_system]] — the token structure `components/*` consume
- [[lesson_split_identity_from_consumed_name]] — the earlier form of the same boundary move
- [[component_button]], the control family that stays native alongside the wrappers
- [[component_lib_boundary]], the folder this decision describes, as actually built by gettori/tori#94
- [[adr_solid_ui_reference]], the design reference wrapper tickets consult for part composition and proportions before styling on tokens

## Amendment (2026-08-12, gettori/tori#95)

As first written, this ADR said adoption was **"per-component and on-demand"**: no primitive wrapped before its first consumer existed, and the existing tested primitives (`Button`, `SegmentedControl`, `Tab`, `Menu`, `Popover`) explicitly **"not migrated"**. The reasoning was the no-unused-surface philosophy of [[adr_theme_palette_roles]]: an unwanted wrapper rots like an unused role.

The inventory done for gettori/tori#93 superseded it. Demand-driven adoption assumed the a11y debt was localized and would surface component by component; it is instead diffuse (14 untested dialogs, 221 `title=` attributes, 8 context-menu consumers, two picker implementations, duplicated icon grids), so waiting for consumers would have kept producing new hand-rolled instances of the exact patterns the wrappers exist to retire. Four of the five primitives named as safe now migrate; of that list only `Button` still stands, alongside its `IconButton` sibling. The no-unused-surface principle survives in a narrower form: the stays-native list is what keeps this from becoming wrap-everything.

The `src/lib/` boundary, the guard test, the token-styling rule and the Storybook workshop are unchanged from the original decision. **The Storybook half is now built** ([[component_storybook_workshop]], gettori/tori#96): the peer conflict this ADR flagged as a risk dissolved upstream, so it runs unpinned on the framework's Solid 1 renderer.

## Amendment (2026-08-12, gettori/tori#94)

The foundation ticket settled one thing this ADR left open: **each `src/lib/` module exports a single namespace object**, so consumers write `Dialog.Root` rather than a bare `Root`. Kobalte names its parts `Root`, `Content` and `Title` identically across dialog, menu, select, popover and tabs, so bare re-exports would collide the first time one wrapper composed two primitives. This binds every later `lib/` module (#102 to #111), not just the dialog. See [[component_lib_boundary]].

Also settled, and worth knowing before the wrapper tickets: Kobalte's dialog cannot be mounted in jsdom at all without the root `clientWidth` shim now in `src/test/domSetup.ts` ([[gotcha_kobaltes_scroll_lock_writes_invalid_css_into_jsdom]]). That was a prerequisite for #98 to #101 rather than a detail of #94.

## Amendment (2026-08-22, RadioGroup and the multi-select counterpart)

`RadioGroup` was on neither the migrating list nor the stays-native list. gettori/tori#109 had rejected it once, for the icon grid, but the reason there was that switching the grid would break existing characterization suites, and that reason does not reach new surface: an agent's question form has no suite to break. RadioGroup therefore joins the **migrating** list, as `src/lib/radio-group.ts` plus a styled `components/RadioGroup/`.

Its `ItemDescription` is re-exported where `checkbox.ts` deliberately omits its `Description`, and the difference is real rather than drift: a checkbox's hint belongs to the one box and its call sites already own an sr-only span, whereas a radio option's second line is part of the choice and has to be announced with the option it describes.

The multi-select counterpart is **not** a new door. Kobalte 0.13.13 ships `checkbox` and no `checkbox-group`, so `components/CheckboxGroup/` is a Tori composition over `<Checkbox>`: the `role="group"`, its accessible name, and the value array. Nothing new touches `@kobalte/core`, so the stays-native list is unchanged and this is not a hand-rolled primitive, only group bookkeeping around a wrapped one.

Measured while building it, and the reason the wrapper does not simply forward `value`: Kobalte reads `value === undefined` as **uncontrolled** and starts keeping its own state, so a radio group handed `undefined` for an unanswered question ticks whichever radio the user pressed even when the caller's value never moved. The wrapper maps "nothing chosen" to the empty string instead. See [[gotcha_kobalte_treats_an_undefined_controlled_value_as_uncontrolled]].

## Shipped so far

- **#98 to #101, dialogs.** `Dialog` plus all fourteen consumers; the legacy chrome deleted. See [[component_dialog]].
- **#102, tooltips.** `lib/tooltip.ts`, the `Tooltip` wrapper, a `tooltip` prop on `Button`/`IconButton`/`Tab`, and every interactive `title=` in the app converted - then the native attribute made a type error on all four. See [[concept_tooltip_trigger_is_the_control]].
- **#104, popover.** `lib/popover.ts` and the `Popover` wrapper rebuilt on Kobalte in anchored controlled mode; HistoryPanel migrated, the 206-line hand-rolled surface deleted, and Terminal stops measuring rects. Measured along the way: Kobalte delivers an outside press to the topmost layer only, so the nested-row-menu behavior the old `dismissable` flag hand-wired comes free. See [[component_popover]].
- **#105, toasts.** `lib/toast.ts` and the stack rebuilt on Kobalte's imperative toaster, gaining the ARIA it never had (labelled region, `role="status"` per toast, Escape on the focused one) plus a `⌘⌥T` focus key. The region also moved out of `LeftSidebar` into `App`: the sidebar had owned the list only because `setError` was its own. Both write APIs survive untouched, so all 87 `TOAST` emitters and every `setError` caller are unchanged, and a characterization test ran green on both implementations with its assertions unmodified. The first wrapper whose primitive is imperative rather than a component tree, which is why `toaster` rides in the namespace object beside the parts. See [[component_toasts]].

Two corrections to the inventory above, both found by measuring rather than counting: the "221 `title=`" figure is stale - the real split is **134 interactive**, 64 non-interactive and ~48 component `title` *props*, which are headings and not hover text at all. And `Button`/`IconButton` staying native is untouched by #102: composing a tooltip is not wrapping them in Kobalte, because the trigger *is* the native button.
