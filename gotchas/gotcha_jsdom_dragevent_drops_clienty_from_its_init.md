---
summary: jsdom ignores clientY in a DragEvent init, so drop-zone math gets NaN and a zone test can pass by accident; define it on the event
status: current
updated: 2026-11-07
source: plan "Sidebar lanes, custom groups and branch line controls" (branch left-sidebar-customization), phase 4; src/panels/LeftSidebar/groupCards.test.tsx (drag helper); src/panels/LeftSidebar/sidebarDrag.ts (zoneAt)
---

# jsdom's DragEvent drops clientY from its init

`createEvent.dragOver(el, { clientY: 20 })` gives an event whose `clientY` is undefined, so `zoneAt(top, height, e.clientY)` computes NaN. The phase 3 zone tests passed only because NaN happened to fall through to the zone they expected. After creating the event, set it explicitly: `Object.defineProperty(ev, "clientY", { value: y })`, along with `dataTransfer`, then `fireEvent(el, ev)`.

## Related

- [[concept_sidebar_arrangement]]
- [[gotcha_jsdom_measures_everything_as_zero_wide_so_overflowtabbar_hides_every_tab_label]] stub `getBoundingClientRect` as well
