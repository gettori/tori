---
summary: a dropdown inside a bar that is position relative and overflow hidden gets clipped by it too, portal it to the body
status: current
updated: 2026-06-29
source: Overflow-tab-bar (personal/tori); `src/components/OverflowTabBar.tsx`, `src/App.css` (`.tab-overflow-menu`)
---

# overflow:hidden on a positioned bar clips its own dropdown

Do NOT render a dropdown as a child of a bar that is both `position:relative` (to anchor the menu) and `overflow:hidden` (to suppress the scrollbar); portal it to `document.body` and position it manually. Why: once the bar is the positioned containing block, its `overflow:hidden` clips absolutely-positioned descendants too, so the menu (which extends below the ~34px bar) is cut off and invisible. The `OverflowTabBar` `+N` menu uses a Solid `<Portal>` with a `position:fixed` rect measured from the count button.
