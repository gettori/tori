---
summary: Settings search never navigates tabs while typing, only badges each with a match count; Enter or a command jumps
status: current
updated: 2026-08-11
source: "Settings redesign: horizontal tab strip with per-tab search counts (personal/sway, branch `settings`, issue #91); Phases 1, 3; commits 7081a08, fe9a640; `src/panels/Settings/{settingsSearch.ts,searchHighlight.ts}`, `src/panels/Settings/Settings.tsx`"
---

# A search that counts instead of navigating

Filtering a tabbed panel has an obvious failure: the thing you searched for is on
another tab, so either the search moves you (and the panel jumps under your
hands, mid-word, on every keystroke) or it does not (and you stare at an empty
pane concluding the search is broken). Sway's Settings search takes neither.
**Typing never navigates. The tabs carry a count instead.**

## The rule and its one exception

- **Typing filters the tab you are on and nothing else moves.** Five keystrokes
  building `minim` from the Appearance tab pass through five states in which
  Editor is the highest-count tab, and none of them may move you.
- **Enter navigates**, to the tab with the most matches, because pressing it is a
  decision rather than a byproduct of typing. Ties resolve to the earliest tab in
  strip order, which falls out of a `>` scan keeping the first maximum rather
  than being applied as a separate rule.
- **A command navigates**, because a `Preferences:` palette row is the user
  pointing at one setting. That is explicit navigation carried out, not search
  auto-jump, and the no-jump rule constrains only the search box.

When the active tab has no matches but others do, the pane says *"No matches
here, N elsewhere"* - deliberately a different message from *"No setting matches
X"*. The first is a tab to click, the second a query to change, and conflating
them is what makes a stay-put search feel broken.

## Row granularity, forced by the badges

The filter was section-level before the strip, on the reasoning that a setting is
understood through the ones around it. Per-tab counts cannot be built on that: a
badge saying how many *sections* a tab has some match in is not a number a user
can check against what they see. `matchingEntries` returns matched entry ids,
a count per tab (**every** tab, including the zeroes - the strip dims a
zero-match tab rather than dropping it, and needs a number to render), and a
total.

The old rule's concern survives in *where* rows are drawn rather than in what the
matcher returns: a filtered row keeps its group heading, and a group whose rows
all vanished takes its heading with it.

**Section and tab titles are not matched**, unlike the retired section-level
rule. A title has no row to count, so counting it would badge a tab with nothing
highlighted underneath. The four sections built at runtime keep their standing
catalogue entry, so they are still found by name and counted once however many
cards they draw.

## The badge's one promise

**A badge's number equals the number of things visibly indicated in its pane.**
That is pinned directly rather than trusted to follow from both halves using the
same matcher, because a count you cannot check against what you see is worse than
no count.

Holding it costs a second module. `fuzzyScore` returns a score, not positions, so
`searchHighlight.ts` restates the matching rules to answer *where* a query
matched - a label as a subsequence walked the same greedy way, a hint as one
substring. The duplication is deliberate and is held together by two tests rather
than by discipline:

- every entry the search counted must mark something, and
- every entry it rejected must mark nothing.

Those fail the moment the two rules drift. Card sections have no row to mark and
are marked whole, which is also exactly what their single catalogue entry means.

## Announcing it

Sighted users read the badges; a screen reader would have to walk the strip, so
each tab's count joins its accessible name ("Editor, 1 match" - singular pinned
by test) and one aggregate is announced in a `role="status"` region.

**Throttled at 500ms, because `aria-live="polite"` queues rather than replaces.**
Announcing per keystroke reads out a backlog of stale totals. The timer is
cancelled on teardown so closing the panel mid-search does not leave it writing
to a disposed signal.

Note the cost, which bit twice during the work: `aria-label` on a tab *replaces*
its accessible name, so every `getByRole("tab", { name: "Editor" })` written
before the counts existed breaks the moment a query runs. See
[[gotcha_an_aria_label_on_a_tab_replaces_its_accessible_name]].

## Boundaries

- The match rule is label OR hint, the same two fields the palette uses, so a
  query that finds a `Preferences:` command finds the row it opens.
- `null` for an empty query rather than "everything": the caller has to tell
  "nothing typed" from "nothing matched", and a zeroed record cannot express both.
- Counting is per catalogue entry, so what the badge counts and what
  [[concept_settings_tab_layer]] renders are the same unit by construction.
