---
summary: the shared tab pill throws with no Tabs.Root above it, and its close button stays hidden since a tablist owns only tabs
status: current
updated: 2026-09-24
source: "Plan \"Tab and OverflowTabBar onto Kobalte Tabs\" (personal/tori, branch `111-tab-and-overflow-tab-bar`, issue #111, closing #114/#115/#132 and the `Tab` half of #116); `src/components/Tab/Tab.tsx`, `src/lib/tabs.ts`"
---

# Tab

**Location:** `src/components/Tab/Tab.tsx` (+ `Tab.module.css`, `Tab.test.tsx`, `Tab.stories.tsx`)

The shared tab pill, used by every strip in the app: the editor's file tabs, the editor's right-pane mode strip, the terminal's session tabs, and the Settings sections. It is a Kobalte tabs trigger wearing Tori's chrome, composed through [[component_lib_boundary]].

## The two things it is

- **A trigger, always.** `value` is required. Selection, the roving tab stop and arrow navigation all come from the `Tabs.Root` above it, never from the call site, so a `Tab` with no `Root` over it throws rather than quietly rendering a button that merely looks like a tab. Before #111 the call sites hand-rolled `active`, `tabindex` and `aria-controls`; all three are gone.
- **A tooltip's control.** The trigger has to *be* the control ([[concept_tooltip_trigger_is_the_control]]), so the two polymorphics stack rather than nest: `Tabs.Trigger as={Tooltip}`. Verified on one element - `role="tab"`, `aria-selected`, `data-key` and the roving `tabindex` from Kobalte, plus `aria-describedby` from the tooltip once it opens. Kobalte types `as` as a bare `ValidComponent` and resolves the child's props from it, which a component generic in its element cannot satisfy, so `as` and `type` each carry a cast; the runtime is one props object either way.

## `TabRow`: what a strip tells its tabs

A strip like [[component_overflow_tab_bar]] does not build its tabs. The consumer hands it a `renderTab`, and a Solid JSX element is already-constructed DOM by the time the bar sees it, so nothing the strip knows can travel as a prop. `TabRow` is the seam, and it carries exactly two facts:

- **`position`** - where this tab sits in the strip's **canonical** list, which is not the row on screen. `aria-posinset`/`aria-setsize` come from it, so a strip with nine tabs hidden announces "3 of 12" rather than "3 of 3". Kobalte writes neither attribute. Settings passes no `TabRow`, and needs none: it renders all six.
- **`inert`** - this subtree is scaffolding. Inside it a `Tab` renders the same boxes with every interactive part `disabled` and no `role` at all. That is what the overflow bar's measuring ghost needs: it has to lay out exactly like the real row to be worth measuring, while joining neither the accessibility tree nor Kobalte's collection, where it would register a second item under every key the real row already holds. `disabled` rather than a `<span>`, so the box metrics stay identical (a span was a guess jsdom cannot check) and `aria-hidden-focus` has nothing to find.

## The close button is hidden from assistive tech

Not a preference. `role="tablist"` may own nothing but `role="tab"`, so there is no shape in which a visible close button is both legal and announced - see [[lesson_a_tablist_may_own_nothing_but_tabs]]. It is a sibling of the trigger inside the pill wrapper, `tabindex={-1}` and `aria-hidden`, and **Delete or Backspace on the focused tab is the path that is actually announced**. That is one tab stop per strip rather than two per tab, which is what the strips wanted anyway.

Consequences worth knowing:

- There is no `closeLabel` prop. A name on a hidden element is read by nobody. It existed before #111 and was deleted rather than made required, which was the plan's original task.
- Tests reach the close through `data-tab-close`, via `closeOf()` in `src/test/tabs.ts`.
- Because the close is a *sibling* rather than a child, a click on it is not a click on the tab, so no `stopPropagation` is needed to stop the tab activating. That same fact is what lets the overflow bar tell a close apart from a selection; see [[component_overflow_tab_bar]].
- `onClose` takes `MouseEvent | KeyboardEvent`, since the keyboard path fires it too.
- **The keystroke half is the one that is *on* a tab**, and it costs the bar a special case. The close button's click has no tab above it, but `onKeyDown` runs on the trigger, so a Delete looks exactly like a selection gesture to anything reading the event's target. Closing writes the tab list before the panel moves the id, and Kobalte heals in between, so a bar that trusted that keystroke would open the leftmost tab. `src/utils/tabGesture.ts` refuses a close keystroke by name for this reason; see [[component_overflow_tab_bar]] and [[gotcha_kobaltes_tab_root_force_selects_the_first_key_and_calls_onchange_doing_it]].

## A locked tab

`locked` takes a mark (the autopilot's turning wheel) and puts it in the close slot, for a tab something else is driving. While it is set, Delete, Backspace and a middle click do nothing, and the close button is not rendered at all, so there is no pointer path either. Say why in `tooltip`. The purple bar across the top is a `::before` layer rather than part of `background`, because hover, selection and a blurred pane all rewrite the background and would erase it. Cmd+W and "close others" live outside the component and still close it; that is #209. See [[component_autopilot_parts]].

## The pill

The wrapper is always rendered, close button or not, so the fill and radius live in one place instead of moving between the wrapper and the trigger depending on whether the strip closes tabs. It carries `role="presentation"`, which is what keeps it out of the tablist's owned children.

The selected look comes from Kobalte's own `data-selected` through `:has`, not from a prop, so the highlight cannot drift from the selection the strip actually holds. `active` was removed from the props in #111 for exactly this reason. **No test can see this**: vitest stubs CSS Modules to the empty string, so the highlight is a manual check.

## Connections

- Rendered by [[component_overflow_tab_bar]] (editor files, editor mode strip, terminal sessions) and by the Settings panel's own strip.
- Enters Kobalte through `src/lib/tabs.ts`, see [[component_lib_boundary]].
- Composes [[concept_tooltip_trigger_is_the_control]].
- Scanned by [[concept_axe_accessibility_gate]], which is what found #115 in the first place.

## Naming a repo without an `aria-label`

Inside a [[concept_feature_workspace]] a tab's accessible name has to read `<repo> / <basename>`, and the one obvious way to do that is the one this component refuses. `aria-label` *replaces* visible text, and 34 `getByRole("tab", { name })` queries depend on the visible text being the name. So the repo arrives as a visually-hidden `patterns.srOnly` span inside the tab's content: `clip-path` based, so it does contribute to the computed name, unlike `display: none`.

The chip beside it is the opposite: `aria-hidden`, and composed **before** the existing glyph rather than into `TabDescriptor.icon`, which is a single slot already holding `FileIcon` or `TabMark`. Composed, the tab says which repo and which kind of file; substituted, it would have cost the second. See [[concept_repository_identity]] and [[component_member_chip]].

## Related

- [[lesson_a_tablist_may_own_nothing_but_tabs]]
- [[component_autopilot_parts]]: the lock mark and why a tab can be locked
- [[gotcha_kobaltes_tab_panel_never_receives_its_aria_labelledby]]
- [[gotcha_a_generic_polymorphic_component_cannot_be_inferred_from]]
