---
summary: an active class and a hover rule tie at the same specificity, whichever is declared later wins, put active after hover
status: current
updated: 2026-07-14
source: Premium Design System for tori (personal/tori, branch code-mirror-6); Phases 3-6; e.g. `LeftSidebar.module.css` `.row.sel` after `.row:hover`, `Editor.module.css` `.editorTabs .tab.active`; see [[concept_design_token_system]]
---

# Same-specificity :hover and .active: declare active last

A selection highlight (`.active`/`.sel`, the gold `--brand-subtle` fill) and a `:hover` background are usually the **same specificity** (one class + the compound/pseudo both land at 0,2,0), so the rule declared **later in the source wins**. Put the active/selected rule **after** the `:hover` rule, or a selected row flips to the plain grey `--hover` the instant the pointer is over it (the gold selection visibly disappears on hover). Do **not** reach for `!important` or an extra class, just order them. Hit repeatedly in the premium restyle: `LeftSidebar` `.row.sel`, `Dialogs` `.pickerItem.active`, `QuickOpen` `.qoItem.active`, and the editor/terminal tab active states each keep their gold-on-hover only because `.active` is the later rule. Relatedly, an inset accent (e.g. a gold active-tab cap via `box-shadow: inset …`) is **not** clipped by the container's `overflow: hidden`, so it is safe on a rounded, clipped tab strip.
