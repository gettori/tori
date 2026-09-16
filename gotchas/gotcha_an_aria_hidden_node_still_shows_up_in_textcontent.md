---
summary: aria-hidden hides a chip from accessible name and role queries but not from textContent, so a toBe check still sees it
status: current
updated: 2026-08-28
source: "Repository identity on tabs, breadcrumbs, quick-open and menus (personal/sway, branch `feature-workspace`, issue #158) - phase 2 - `src/components/MemberChip/MemberChip.tsx:76` - _2026-08-28_"
---

# An `aria-hidden` node still shows up in `textContent`

Do NOT use `element.textContent` to assert what a tab or row says once it wears a decorative chip. Why: `aria-hidden` is respected by accessible-name computation and by role queries, and by nothing else, so the chip's initials are still in `textContent` and a `toBe("a.txt")` assertion fails with `"APa.txt"`. Query by role and name, or read the label span directly. Same family as [[gotcha_an_aria_label_on_a_tab_replaces_its_accessible_name]], from the opposite direction.
