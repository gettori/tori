---
summary: DiffRows computes each row's selectable flag once at creation, so toggling selection only affects rows built after
status: current
updated: 2026-08-03
source: "Editor Wave 3: GitHub as a first-class surface (personal/tori, branch `wave-3`); Phase 11; `src/panels/Editor/DiffRows.tsx:55`; commit 8e6f03b"
---

# `DiffRows` reads `props.selection` once per row

Don't expect toggling selection mode to make existing rows selectable. Why: each row computes `selectable` once from `props.selection` at creation (`DiffRows.tsx:55`), so turning selection on or off only takes effect for rows built afterwards; the row array has to be rebuilt for the change to be visible.
