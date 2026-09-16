---
summary: Button anchors a control family on shared control height tokens, and title is now a type error in favor of tooltip
status: current
updated: 2026-08-15
source: "Button component + migrate all buttons (personal/sway, branch code-mirror-6); `src/components/Button/Button.tsx`, `Button.module.css`, `src/styles/tokens.css`; reworked fixed-height + sibling primitives + call-site migration: plan \"A font-driven scaling system + unified controls\" (branch terminal-editor-design) Phases 4-5; `title` retired for `tooltip`: plan \"Tooltip primitive and the `title=` sweep\" (branch `102-tooltip-primitive`, issue #102); commits c996ca9, dbfa12a"
---

# Button

**Location:** `src/components/Button/Button.tsx`, `src/components/Button/Button.module.css`; sibling primitives in `src/components/{IconButton,SegmentedControl,Tab}/`, shared `src/components/controls.ts`

The one native button for the whole app: text, icon+text, or icon-only, on the shared two-tier tokens, and now the anchor of a small **control family** (`Button`, `IconButton`, `SegmentedControl`, `Tab`) that all share the `--control-*` scale tokens so a button, an icon button, a segmented strip, and a tab of the same size line up pixel-for-pixel. It retired all three prior button systems: the global `.btn` block (`App.css`), the dialog `modalBtn` block (`Dialogs.module.css`), and unstyled bare `<button>`s. A plain `<button>` is already accessible, which is why this family **stays native** even under the wholesale Kobalte adoption of [[adr_headless_primitives]]: there is no meaningful headless counterpart to buy, and 43 consumers would be churned for nothing. `SegmentedControl` and `Tab` are the exception, they migrate (onto Kobalte ToggleGroup and Tabs) because their roving-focus and `role=tab` behavior is exactly what the primitives layer exists to own.

Named exceptions keep bespoke styling (they adopt the scale tokens but not the primitives): `WindowControls` traffic lights, the sidebar space bar (gear + space tiles + add, one borderless-tile family), `UpdatePill`, SpaceDialog tiles, the Terminal split button, plus a few structurally-coupled natives (`OverflowTabBar`'s `+N` count, the overflow-menu close row, `CheckpointTimeline`'s `role=option` turn chip). Note that "bespoke" now means bespoke *styling* only: #102 moved every one of those that needed hover text onto `<Tooltip as="button">`, which renders the same native element and adds no chrome ([[concept_tooltip_trigger_is_the_control]]).

## API

Extends `Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "type" | "title">` and spreads the rest onto the native `<button>`.

- `variant?: 'default' | 'primary' | 'success' | 'warn' | 'danger' | 'ghost'` (default `default`).
- `size?: 'md' | 'sm' | 'xs'` (default `md`).
- `icon?: JSX.Element` — leading icon (inline `<svg>` or a seti component); `iconRight?` trails the label.
- `children` — the text label (wrapped in a `.label` span).
- `type` defaults to `"button"` (no accidental form submits; there is no native `<form>` in the app anyway), and is narrowed to the three real values: Solid still types the native attribute with the long-dead `"menu"`.
- `tooltip?: string` — hover/focus text, and the accessible name for an icon-only button. `tooltipPlacement?` and `tooltipWhenDisabled?` go with it.
- **`title` is a type error**, not merely discouraged. See below.

Refs forward correctly (`ref={ok}` autofocus on dialog confirm buttons) because Solid's `spread` runs a dedicated render effect that calls a function ref against the real node.

## Variants and sizes

Ported from the old `.btn` + `modalBtn` blocks, unified onto tokens (`--hover`, `--border`, `--accent`, `--danger`, `--warn-strong`, `--success`). Each size is now **fixed-height** on the scale tokens (`--control-height{,-sm,-xs}` = `calc(28/24/20px * var(--ui-scale))`, no floor), with horizontal padding only; icons are `--control-icon` (16px scaled). With `box-sizing: border-box` the height is the true outer box, so text / icon+text / icon-only of a size are pixel-identical, and the whole family scales with the UI ([[concept_ui_scaling_system]]). `.iconOnly` collapses to `padding:0; aspect-ratio:1`.

- **Colored** (`primary`/`success`/`warn`/`danger`): filled background, white label, hover via `filter: brightness(1.08)` (from `modalBtn`).
- **Flat** (`default`/`ghost`): `default` uses the `--hover` fill base; `ghost` is transparent. Both keep the `.btn` border and hover to an accent border (from `.btn`).
- `success` is net-new (green approve, no current call site); its `--success` token was added to [[concept_design_token_system]] with the dark value equal to the `var()` fallback so dark stays byte-identical.

**Migration mapping rule** (used when adopting old buttons): old filled (`background: var(--hover)`) → `default`; old transparent/borderless → `ghost`. `warn` came from `modalBtn.warn`; the old hardcoded `.btn.danger` `#d04444` folded into the token-based `danger`.

## Icon-only accessibility, and the `title` that used to serve it

`iconOnly = icon != null && children == null`. An icon-only button **must** carry an accessible name: an explicit `aria-label` wins, else `tooltip` backfills it; a dev-only `console.warn` fires when an icon-only button has neither. `×`-glyph buttons pass the glyph as **children** (not `icon`) with an explicit `aria-label`, so they read correctly and never trip the icon-only warning, while the SVG gear passes via `icon` to get square icon-only padding.

**Until #102 that fallback was `title`, and `title` was always emitted as a hover tooltip.** Both are gone. A native `title` never appears for a keyboard user, so it was doing the accessible-name job for 101 sites across the app while showing nothing to half of them. `Button` now renders `<Tooltip as="button">` internally and forwards `tooltip`; the four tooltip-bearing components (`Button`, `IconButton`, `Tab`, `Tooltip`) all `Omit` `"title"` from their props, so writing one is a compile error rather than a convention. The mechanism, the delays and the disabled-control caveat are in [[concept_tooltip_trigger_is_the_control]]; what stops a raw `<button title=…>` reappearing elsewhere is [[concept_named_exemption_guard]].

## How it works (load-bearing detail)

- **Dynamic `classList` keys.** The variant/size classes are applied as `classList={{ [styles.btn]: true, [styles[variant ?? "default"]]: true, [styles[size ?? "md"]]: true, [styles.iconOnly]: iconOnly() }}`. This requires **empty placeholder rules** `.default {}` and `.md {}` to exist in the CSS module so those lookups resolve to a real hashed name instead of `undefined`, see [[gotcha_css_modules_empty_placeholder_rules_are_load_bearing_for_dynamic_classlist_keys]]. Solid compiles `classList` to a getter re-read on each access, so a reactive `variant={confirmDelete() ? "danger" : "default"}` updates live.
- **Component-owned `classList` is exclusive.** Because Button sets its own `classList`, a caller **cannot** pass `classList={{ active }}` through the spread, see [[gotcha_a_component_that_sets_its_own_classlist_clobbers_a_callers_classlist]]. Stateful widgets were therefore not forced through Button; instead they got **dedicated sibling primitives** that own their state internally: `IconButton` (square, brand-fill `active` + an explicit `aria-pressed` prop for accent-when-hidden toggles), `SegmentedControl` (radiogroup, roving arrow-nav via the shared `nextSegmentIndex` in `controls.ts`), and `Tab` (pill, `role=tab`, optional `icon`/`trailing`/`onClose`). Phase 5 migrated the once-native toggles (Follow/preview/file-tree, the topbar pane cluster), segmented strips (New Project mode), and tab strips (editor, terminal, right-panel mode) onto them. A caller may still pass a plain `class` (applied alongside) for layout-only concerns.
- **#108 supersedes that for two of them.** `SegmentedControl` is no longer a hand-rolled radiogroup: it runs on Kobalte's toggle group, its segments are `aria-pressed` toggle buttons, and arrows move focus rather than the selection ([[component_toggle_group]]). The topbar pane cluster went with it and is no longer three loose `IconButton`s, though each toggle item still renders *as* an `IconButton`, so the look and the tooltip stay this family's. Both now take their selected visual from the primitive's `data-pressed` attribute, which is the answer the clobber gotcha was missing: an attribute the primitive owns is not something a component's `classList` can erase. `nextSegmentIndex` survives for the Settings tab strip alone, until the `Tab` ticket.

## Adoption notes

- Every dialog confirm/cancel pair, the Toolbar and LeftSidebar action buttons, and the icon/glyph buttons (App gear, Settings close/Import, Toasts dismiss, Terminal search `↑ ↓ ×`, FileTree New File/Folder, CodeEditor Reload/Keep-mine, PickerModal clear) use `<Button>`.
- When migrating a button whose styling came from a **descendant** selector (`.termSearch button`, `.reloadBanner button`), delete that rule or it bleeds onto the migrated Button, see [[gotcha_descendant_x_button_selectors_bleed_onto_a_migrated_button]].
- Bespoke classes with real layout value are trimmed to layout-only and kept (`.topbar-gear`, `.toastClose`, `.pickerClear`); `margin-left:auto` for a right-pushed button moves to an inline `style`.

## Connections

- Styled entirely on [[concept_design_token_system]] (two-tier tokens); it added the `--success` semantic token.
- Sized by [[concept_ui_scaling_system]] (the `--control-*` scale tokens) so the whole family zooms with the UI.
- Governed by [[adr_stack_choice]] (Solid front end), the styling direction in [[adr_ui_config_system]], and [[adr_headless_primitives]], which puts `Button`/`IconButton` on the stays-native list while `SegmentedControl` and `Tab` move to Kobalte. Composing a tooltip does not contradict that: the trigger *is* the native button.
- [[concept_tooltip_trigger_is_the_control]] — the `tooltip` prop, and why `title` is now rejected outright.

## Related

- [[gotcha_css_modules_empty_placeholder_rules_are_load_bearing_for_dynamic_classlist_keys]]
- [[gotcha_a_component_that_sets_its_own_classlist_clobbers_a_callers_classlist]]
- [[gotcha_descendant_x_button_selectors_bleed_onto_a_migrated_button]]
