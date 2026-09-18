---
summary: Settings tabs only group the same eleven sections, derived from one table so grouping and its inverse cannot disagree
status: current
updated: 2026-08-11
source: "Settings redesign: horizontal tab strip with per-tab search counts (personal/tori, branch `settings`, issue #91); Phases 1-2; commits 7081a08, 782c8d2; `src/utils/settingsCatalog.ts`, `src/panels/Settings/{Settings.tsx,paneKit.tsx,panes/}`"
---

# Settings tabs as a layer over the catalogue

The Settings panel is six tabs over the same eleven `SettingSection`s it always
had. **The tabs are a grouping layer, not a parallel taxonomy**: sections stay
the unit a setting belongs to and the unit the panel titles, and a tab is an
ordered set of them. That is what let the panel go from one scrolling column to a
tab strip without a single `SettingEntry` moving, and what would let it become a
vertical rail by touching only navigation chrome.

`SETTING_TABS` lives in `settingsCatalog.ts` beside `SETTINGS`, and
`TAB_OF_SECTION` is **derived from it** rather than written beside it, so the
grouping and its inverse cannot disagree. A guard test holds the mapping total
and disjoint: a section in no tab is a set of settings nothing renders, and a
section in two is a row found twice and a search count that double-counts it.
That totality is also what stops [[concept_counting_search]] producing `NaN`.

## The icon is a name, not a component

`SettingTabDef.icon` is a kebab-case lucide id (`"file-code"`), and
`Settings.tsx` maps it to the component at the point of render.

This looks like indirection for its own sake and is not. `settingsCatalog.ts` is
data-only **as a bundle constraint**: `commands.ts` imports it, `hotkeys.ts`
derives from `commands.ts`, and `TerminalView` imports `hotkeys.ts`, so anything
reachable from the catalogue lands in the terminal's chunk. Its only pre-existing
import is an `import type`, which the bundler erases. Six imported icon
components would have dragged lucide in behind them. A test pins the names to
kebab-case so a stray `Bot` cannot ship a tab with a hole where its glyph should
be, and a second test fails if a tab names an icon the map has not got.

The same reasoning is why the row-level matcher lives in
`panels/Settings/settingsSearch.ts` rather than in the catalogue: it imports
`fuzzyScore`. See [[concept_command_registry]] for the chunk-size constraint
stated from the palette's side.

## Every pane stays mounted

All six panes render; the inactive ones carry `hidden`. A tab switch therefore
keeps each pane's scroll position and any half-typed field, and costs no remount.

`hidden` is doing double duty: it is also what keeps five panes of controls out
of the dialog's focus trap, which walks `panelEl` and filters
`el.closest("[hidden]")`. The filter also drops `tabindex="-1"`, because the five
tab pills the roving index has parked still match the selector's `button` clause
and are not stops a real browser would make.

## The panes and the kit

Six components under `panels/Settings/panes/`, over a shared `paneKit.tsx`
holding the row primitives (`Row`, `ToggleRow`, `TodoTagsRow`, `CardSection`,
`Group`), the writers that go through `saveSettings`, and the number coercion.
All of it was local to `Settings.tsx`'s closure until the split; nothing in it
closed over anything per-render, only over the imported store, which is what made
the move a move rather than a rewrite. `EDITOR_TOGGLES` is re-exported from
`Settings.tsx` so `editorSection.test.tsx` still reads it from where it always
did.

- **`Group` hides its heading when a query filtered all its rows away.** A
  heading over nothing reads as a section that failed to load rather than as one
  with no match in it. It takes the ids it covers, usually via `idsIn(section)`;
  Chat's three groups (Sessions / Safety / Spending) write theirs out, because
  that grouping cuts across the `chat` and `checkpoints` sections and cannot be
  derived from either.
- **`CardSection` wraps the four sections whose controls only exist at runtime**
  (agents, language servers, debuggers, GitHub). Each carries one standing
  catalogue entry, so it is shown, hidden and marked whole. Its wrapper div
  carries `.section`'s top margin, because wrapping a `<section>` makes it
  `:first-child` of that wrapper and the existing `.section:first-child` rule
  would otherwise zero it - two stacked card sections butted together in the
  Languages pane until that was noticed.
- **`Row` defaults its hint to the catalogue's**, with the prop as an override.
  Several rows deliberately say more on screen than the catalogue needs for
  searching; what they should not do is restate the *same* sentence in two files.

A rendering test asserts every catalogue entry reaches exactly one row (or one
card section) on screen, which is what catches a setting dropped during a
hand-split across six files.

## Boundaries

- The tab strip is chrome. Panes, catalogue grouping and search are all
  layout-agnostic, so a rail conversion touches navigation only.
- Section ids, `settings.json` namespaces and the JSON schemas were untouched by
  the redesign; see [[component_settings_store]] for the four homes a setting has.
- `role="dialog"`, `aria-modal`, the focus trap and two-stage Escape arrived with
  the strip - the panel had none of them before. See
  [[gotcha_a_capture_phase_window_listener_reaches_over_a_modal_opened_on_top_of_you]].
