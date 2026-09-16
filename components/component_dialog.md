---
summary: Dialog is the one modal shell every dialog composes, with a keyboard reachable scrolling body no axe check would catch
status: current
updated: 2026-08-16
source: "plan \"Dialog primitive on Kobalte with stories and behavior tests\" (personal/sway, branch `98-dialog-primitive`, issue #98, part of #93); `src/components/Dialog/Dialog.tsx`, `Dialog.module.css`, `Dialog.test.tsx`, `Dialog.stories.tsx`; extended by plan \"Migrate the seven simple dialogs onto Dialog\" (branch `99-migrate-seven-dialogs`, issue #99) and plan \"Migrate the seven complex dialogs onto Dialog\" (branch `100-migrate-seven-conplex-dialogs`, issue #100, PR #125); `src/components/Dialogs/`, `src/components/ShortcutSheet/`; the surface seam: plan \"Tooltip primitive and the `title=` sweep\" (branch `102-tooltip-primitive`, issue #102); `src/components/Dialog/surface.ts`; commit c996ca9; height hook + the palette joining the set: plan \"Consolidate the filter-and-pick surfaces onto one Kobalte Combobox\" (branch `110-pickermodal-and-chatpicker`, issue #110, PR #140); commit `9d471b7`; recipe, motion and the `headHidden` rule: plan \"Re-audit Dialog and Tooltip against the solid-ui reference\" (branch `130-re-audit-dialog-and-tooltip`, issue #130); `scripts/check-tokens.mjs` check 9"
---

# `Dialog`: the one modal surface

The first styled wrapper on [[component_lib_boundary]]: Kobalte's dialog behind Sway's chrome and Sway's API. Every dialog in the app composes this, so the Portal, backdrop, Escape, focus trap and focus restore are written once instead of fourteen hand-rolled copies. **All fourteen are migrated** as of #100, and #101 **deleted** the legacy chrome: `.modal`, `.modalBackdrop`, `.modalTitle`, `.modalActions` and `.modalDanger` no longer exist. It is deliberately a *shell*: the bodies stay with their dialogs.

There is no longer an overlay that is not a `Dialog`. The command palette was the holdout, hand-rolling its own portal, backdrop, `role="dialog"` and outside-press dismissal, and #110 moved it on ([[component_command_palette]]); the `Omnibox.module.css` copy of the legacy chrome #101 made is gone with it. See [[gotcha_deleting_a_rule_from_a_shared_css_module_unstyles_the_consumer_you_were_not_looking_at]] for what the shared version cost on the way.

## What it owns

- **The chrome**, ported from the legacy `.modalBackdrop`/`.modal` rules that #101 has since deleted: `--scrim-default` backdrop, `--canvas-card` panel, `--border-default`, `--sway-radius-xl`, `--shadow-lg`, on [[concept_design_token_system]].
- **The recipe**, re-audited against the reference in #130 and now entirely on the ramps (it was not: 20, 14 and 12 were raw `px * --ui-scale`). Panel `padding: var(--sway-space-7)`; the panel is a flex column with `gap: var(--sway-space-6)`, so head, body and actions space themselves and a part that is not rendered costs nothing; `.head` is its own column at `gap: var(--sway-space-3)`, because a title and its description are one block rather than two; title `--sway-text-3xl` + `--sway-line-tight` + 600 on `--fg-default`; description `--sway-text-lg` on `--fg-muted`; actions `gap: var(--sway-space-4)`, right-aligned. Radius stays `--sway-radius-xl` against the reference's 8px, because [[adr_premium_design_system]]'s rounded-container identity is the clause where Sway wins.
- **`.headHidden`, so a hidden title costs no gap.** Spacing moved from margins to one `gap`, and a gap is paid between *flex items*, not between visible things. `.titleHidden` is `position: absolute` and so already out of flow, but the `div` wrapping it is not, and an empty flex item still earns a gap on both sides - which would have opened the command palette with a dead band above its filter field. When the title is hidden **and** there is no description, the wrapper takes `display: contents`, dropping its own box and leaving the out-of-flow title where it was. With a description it stays an ordinary flex item, since it still has something visible to hold. See [[gotcha_an_empty_flex_item_still_earns_a_gap_on_both_sides]].
- **Three sizes.** `confirm` 420px and `sheet` 480px are fixed ladders on `--ui-scale`; `wide` is `clamp(680px * --ui-scale, 52vw, 1040px * --ui-scale)`. Prose and a single form column read worse the wider they get, so they hold their measure; `wide` carries grids and tables, where a large monitor genuinely buys columns. This is the first deliberate exception to [[concept_ui_scaling_system]]'s one-knob rule.
- **A bounded, scrollable panel.** `max-height: var(--dialog-max-height, min(85vh, 720px * --ui-scale))` with head and actions pinned and the body scrolling. Kobalte locks the page behind a modal (`preventScroll` defaults to `modal()`), so a panel taller than the window would put its own actions row out of reach with no way to scroll to it.
- **A height hook, `--dialog-max-height`** (#110). A caller wanting a shorter panel than 85vh (the command palette, whose list wants to stop sooner) sets the variable from its own class rather than redeclaring `max-height`. Both would be a single class on the same element, so the winner would be decided by bundle emit order: [[gotcha_a_css_module_redeclaring_a_property_another_module_sets_on_the_same_element_is_settled_by_bundle_order]]. `scripts/check-tokens.mjs` check 8 fails if this file stops reading the hook.
- **`.body` is the scroller its consumers rely on**, not an implementation detail. Both filter-and-pick surfaces stopped scrolling their own lists once they moved inside a dialog, and each pins its filter field with `position: sticky; top: 0` instead. Check 8 asserts `.body` still declares `overflow-y`, because a bound with nothing scrolling under it puts rows out of reach exactly as no bound does. See [[lesson_a_declaration_goes_inert_when_its_parent_changes]].
- **`aria-modal="true"`**, passed explicitly. See [[gotcha_kobaltes_dialog_never_sets_aria_modal]].
- **Focus capture and restore**, because Kobalte's does not apply here. See [[gotcha_kobaltes_modal_close_restores_focus_to_a_trigger_you_may_not_have]]. Restore is a no-op when the opener is gone by close time, which is every context-menu-launched dialog: focus lands on `<body>`, asserted explicitly rather than left to chance.
- **A focus fallback when `initialFocus` is refused.** After applying it, the wrapper checks whether focus actually landed inside the panel and takes the panel if it did not. A `disabled` control will not accept focus, and a gated dialog naming its own confirm button hits that every time it opens `busy`. See [[gotcha_a_disabled_element_named_by_initialfocus_leaves_the_focus_trap_holding_nothing]].
- **`onKeyDown` on the panel** (#100), reaching the actions row and the panel itself, which are the wrapper's markup rather than the caller's children. Escape is deliberately **not** this handler's business: Kobalte closes on it and reports that through `onClose`, so handling it here fires twice.
- **`class` passthrough onto the panel** (`Dialog.tsx:92`). This is the contract #99/#100 depended on while the legacy chrome was still being composed onto the panel (`PickerModal` as `.modal .picker`, `ConfirmDeleteSpace` as `.modal .modalDanger`); without it those migrations would have had to reach past the wrapper into `lib/`, which the boundary guard forbids. Both cases have since resolved into the wrapper's own vocabulary, `size="sheet"` and `Dialog`'s scrolling body, so as of #101 the passthrough carries no legacy chrome.
- **Its own panel, published to whatever is inside it** (`src/components/Dialog/surface.ts`, #102). `Dialog.Content` calls `createHideOutside`, which aria-hides everything outside the panel, so anything that portals to `document.body` while a modal is open is painted on screen and invisible to a screen reader at the same time. The panel goes into a context that [[concept_tooltip_trigger_is_the_control]] reads as its default `mount`, which is why the six dialog tooltips #102 swept needed nothing at their call sites. The seam file imports only `solid-js`, so it creates no cycle with `Tooltip`. Any future portalling part inside a dialog wants the same context.
- **`titleHidden`**, a visually-hidden title. `title` is required so every dialog has an accessible name, but `ShortcutSheet` has no title *line*; inventing one would make a shell swap into a redesign. The command palette uses it too, and draws its *own* heading naming the mode - a copy of this file's `.title` recipe living in `Omnibox.module.css`. It cannot be shared (a cross-module `composes` is what this cluster deliberately avoids, and both rules on one element would put the winner in the bundler's hands), so `check-tokens.mjs` **check 9** asserts the two agree on `font-size`, `line-height`, `font-weight` and `color` instead. #130 added it after moving the title from 16px to 18px left the palette's heading two steps smaller with nothing failing.

## What it does not do

- **No close (X) button.** No legacy dialog has one, and adding it would put markup in #99/#100 that the characterization tests never had. It also sidesteps [[gotcha_kobaltes_closebutton_labels_itself_dismiss]] entirely, since the part is never rendered. #130 re-examined this against the reference, which *does* place an absolute `CloseButton` top-right, and **kept the omission**: every dialog here already carries an explicit Cancel or Done and Escape closes, so an X would add a fifteenth way out of a surface that has two, across fourteen consumers.
- **No Enter-to-confirm, no `danger` variant, no body markup.** Those belong to the consumer. In practice #99 found that a consumer with a field keeps an Enter handler on it, and a consumer with only buttons keeps none at all: the focused default button is clicked by Enter without anyone's help. #100 found the third case, which is why `onKeyDown` exists (below).
- **No reason on `onClose`.** One callback reports Escape and an outside press alike, which is what forces `CreatePrDialog` to split its busy guard across two places (below).
- **No anchored or non-modal variant.** `lib/dialog.ts`'s allow-list does not export them yet. (The exit animation this line used to disclaim arrived in #130, below.)

## The keyboard-reachable body

The scrolling body carries `tabindex={0}` and is rendered only when there are children. A dialog whose body holds no control of its own (a long confirmation, a list of plain rows) is otherwise unscrollable by keyboard: the panel has focus, but the body is the scroller and the page behind is locked. The cost is one tab stop, and it is the **first** tab stop in any dialog with content, ahead of its buttons.

No axe assertion can guard this, which is why a hand-written test does (`Dialog.test.tsx:118`). See [[gotcha_a_tabindex_less_scroll_region_passes_every_axe_run_under_jsdom]] and the "what the disabled set costs" note in [[concept_axe_accessibility_gate]].

## Stacking

`z-index: 1250`, above the toasts' 1200 and the legacy dialogs' 1100. A modal aria-hides the toast region, so a toast painting *over* a dialog it is hidden from is incoherent; equal values would have left the order to whichever portalled last. `ShortcutSheet`'s 1200 exception disappears at migration.

## Motion (#130)

The **first animation in the component layer**, so the shape here is what the remaining wrapper tickets should copy. Backdrop and panel both animate on Kobalte's `[data-expanded]` / `[data-closed]`, which the probe in #130 confirmed land on the overlay and the content themselves. Enter is `--sway-duration-med`, exit `--sway-duration-fast` - an opening dialog is asking to be read, a closing one is already answered and only owes the eye continuity. The panel fades and scales from `0.95`; the backdrop only fades, since a scrim that also zooms draws attention to itself and has no shape to zoom.

**Four keyframes, never two reversed.** Kobalte keeps a closing dialog mounted through `solid-presence`, which decides whether an exit is running at all by comparing `animation-name` across the open/closed flip. One name used in both directions compares equal, presence concludes nothing is animating, and the panel is torn down instantly: the exit silently never plays while the CSS reads as though it should. Enter and exit are therefore separately named and must stay that way. See [[gotcha_solid_presence_decides_there_is_no_exit_when_both_directions_share_an_animation_name]].

Both panel keyframes restate `.panel`'s own `translate(-50%, -50%)`, because `transform` is one property and a keyframe setting only `scale()` drops the centering for the animation's duration. The centering is now written in three places with nothing checking they agree.

`@media (prefers-reduced-motion: reduce)` sets `animation: none` on all four rules. That is safe rather than a leak: `solid-presence` reads the computed `animation-name`, treats `none` as "nothing to wait for", and unmounts on the spot instead of hanging on an `animationend` that will never fire.

None of this is visible to any test: vitest hands back a class-name proxy and never parses the declarations, so the motion rests on the manual walk recorded with #130.

## Escape from terminal focus, measured

Escape closes a dialog opened while the terminal had focus, with **no capture-phase `window` listener anywhere in the wrapper**. Kobalte's focus scope moves focus into the panel on open, so the keystroke originates inside the dialog and never reaches xterm's handler at all. This is the evidence #99 needs before deleting `ShortcutSheet`'s manual hack; it was checked in the running app, because jsdom cannot reproduce [[gotcha_a_focused_xterm_swallows_keydown_before_window]].

## The seven consumers, and what composing it looks like (#99)

`ConfirmDialog`, `PromptModal`, `ShortcutSheet`, `AskpassDialog`, `InitGitDialog`, `NewProjectDialog` and `CreatePrDialog` migrated as a shell swap: bodies and per-dialog CSS stayed, the chrome moved here. The pattern that came out of it:

- **`open` stays internal.** Every call site already mounts its dialog under a parent `<Show when={req()}>`, so the dialogs pass `open` themselves and no panel file changed. `AskpassDialog` is the exception that proves the shape: it derives `open={!!current()}` from its queue and keeps an inner `<Show>` for the body, so one git op's username and password prompts share a panel instead of tearing it down between fields.
- **Escape belongs to the wrapper, everywhere.** Every local Escape handler was deleted; a second one would resolve the same pending request twice.
- **`initialFocus` focuses and nothing else.** `PromptModal` needs its seeded value *selected* too, so it selects inside the accessor and returns the element (`initialFocus={() => { input?.select(); return input }}`); focusing an input does not clear a selection it already has.
- **A body wrapper carries what the panel cannot.** A form's Enter handler goes on a `<div>` around the fields. It sees keys only from inside the body, which is why `ConfirmDialog` (buttons only, no body controls) ended up with no Enter handler at all.
- **`size` is usually omitted.** The default `confirm` is exactly the legacy `.modal`'s 420px, so six of the seven say nothing.
- **A route-dependent guard needs both halves.** `CreatePrDialog` must ignore an outside press while a submit is in flight but still honour Escape. With one reasonless `onClose`, the pointer half is refused there and the key half lives in a local handler that runs *only* while `busy`.
- **Naming a field: point at the visible label.** `aria-labelledby` at the `.modalLabel` line above the input, not an `aria-label` repeating that text, so the two cannot drift.

`ShortcutSheet` gave up the most and is the evidence for the "Escape from terminal focus" section above: its capture-phase `window` keydown and its manual focus save/restore are both gone, and its tests show Escape still closes and focus still returns. Its width is not the wrapper's to decide, though: `wide` is a clamp that grows to 52vw where the sheet has always been a fixed 680px, so it keeps its own rule, hoisted out of `@layer components` and doubled ([[gotcha_an_unlayered_css_module_beats_a_layered_one_at_any_specificity]]).

Two dialogs open at once is now reachable, since `AskpassDialog` is mounted app-wide. Focus and dismissal survive the stack; only axe's `aria-hidden-focus` cannot answer under jsdom ([[gotcha_two_stacked_modals_make_aria_hidden_focus_unjudgeable]]).

## The other seven, and the seam they needed (#100)

`WorktreeRemoveDialog`, `BranchRemoveDialog`, `ConfirmDeleteSpace`, `DebugTargetDialog`, [[component_picker_modal]], `SpaceDialog` and `ProjectIconDialog`. Bigger bodies than #99's, and three things the simple seven never exercised:

- **A key seam was missing, and #99's "Enter belongs to a body wrapper" answer does not generalise.** A wrapper inside `children` cannot see the actions row or the panel, and those are exactly where the key lands in the two cases that matter: a gated confirm button is `disabled`, so the browser fires no click on it, and a dialog whose `initialFocus` resolves to nothing leaves focus on the panel where no control answers at all. `DebugTargetDialog` in file mode is both at once and is the concrete motivation. Hence `onKeyDown`, the one prop this wave added.
- **No size invention.** The legacy `.modal` is 420px, which is `confirm` exactly, and `.modalDanger` is 480px, which is `sheet` exactly, so every panel kept the width it already had and the three body-heavy dialogs took the default rather than the `sheet`/`wide` the plan guessed at. The one visible change is height: the panel ladder is `min(85vh, 720px)` where `PickerModal`'s own rule had been `min(70vh, 520px)`.
- **`class` was not needed after all**, despite being written into the plan as the picker's escape hatch. `Dialog`'s body is already a bounded, focusable scroller, so the picker's list simply stopped scrolling itself and its filter field became `position: sticky` inside the body. That is what the old `.picker` flex column had bought; the rule is now dead. `class` remains on the API and remains unused by these seven.

Enter reduced to the same four lines in four of them (`if (e.key !== "Enter") return; preventDefault(); if (!busy) confirm();`), with one deliberate exception: `ConfirmDeleteSpace` keeps its handler on the **input**, not the panel, because hoisting it would widen its type-the-name gate from the field to the whole dialog. There is a test that fires Enter at Cancel to pin exactly that.

Accessibility was the part that widened. Four fields had no accessible name and two more only appeared to ([[gotcha_axe_accepts_a_placeholder_as_an_accessible_name]]); all six are now named from their visible label line. The picker's rows became a real `listbox` ([[component_picker_modal]]). No rule override survives in the seven files.

## Connections

- [[component_lib_boundary]] - the seam it composes, and the only door `@kobalte/core` comes through
- [[adr_headless_primitives]] - the decision this implements; #98 is the wrapper the whole dialog wave stands on
- [[adr_premium_design_system]] - the spacious-chrome identity the ported panel keeps
- [[concept_ui_scaling_system]] - the one-knob rule, and the `wide` clamp that is its first exception
- [[concept_axe_accessibility_gate]] - the gate its three content-shape assertions run against, and the blind spot it had to cover by hand
- [[component_button]] - what fills the `actions` slot
- [[component_storybook_workshop]] - where its six stories are judged, including the two checks jsdom cannot make
- [[component_picker_modal]] - the #100 consumer that changed rather than moved, and the one whose geometry `class` was reserved for and did not need
- [[lesson_characterize_the_contract_not_the_shape]] - how the fourteen were made safe to move, and the split that made "the tests pass unchanged" mean something
- [[lesson_a_probe_that_measures_too_early_reports_no_problem]] - the stacked-modal measurement, and why the first answer was the wrong one
- [[lesson_a_gate_only_sees_the_configuration_the_test_builds]] - why two of these dialogs' axe baselines were green about markup the app never renders
- [[concept_tooltip_trigger_is_the_control]] - the consumer of the panel seam, and why a body-portalled tooltip inside a modal is invisible
- [[gotcha_kobalte_writes_aria_hidden_a_timeout_and_a_frame_after_mount]] - what makes an assertion about that seam pass without testing anything
- [[component_menu]] - the next wrapper family on the same seam (#103), which copies this one's shape and its focus-restore pattern, and portals into `surface.ts`
