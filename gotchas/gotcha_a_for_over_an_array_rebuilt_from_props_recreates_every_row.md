---
summary: a For over an array rebuilt from props gets a new identity each read, so Solid rebuilds every row and drops focus
status: current
updated: 2026-08-15
source: "plan \"SegmentedControl onto Kobalte ToggleGroup, absorb LayoutToggles\" (personal/sway, branch `108-segmented-control`, issue #108); `src/components/LayoutToggles/LayoutToggles.tsx`, `LayoutToggles.test.tsx` (\"keeps its buttons, and the focus on them, when a pane flips\"); see [[component_toggle_group]]"
---

# A `<For>` over an array rebuilt from props recreates every row

`<For each={items()}>` keys by reference identity, so if `items()` builds its array (and its objects) from props on every read, every prop change hands Solid a wholly new list: it tears down all the rows and builds them again. The visible cost is not the DOM churn, it is that **keyboard focus falls to the body** mid-interaction, and any primitive holding a collection of those elements (a Kobalte toggle group's roving focus) re-registers under it. `LayoutToggles` hit this with three panes whose `disabled` and `tooltip` are derived from props: pressing a toggle re-rendered the parent, and the button the user had just focused no longer existed. Write a small fixed set out explicitly, or key the list off something stable and read the reactive parts inside the row. **A test that renders fixed props cannot see this** - the props have to actually change, so assert element identity across a signal flip (`expect(after).toBe(before)`).
