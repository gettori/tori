---
summary: a left edge rail lands inside the rounded corner once a row becomes an inset pill, use fill weight not a rail
status: current
updated: 2026-07-31
source: branch `navigation`, History restyle; `src/panels/Terminal/HistoryPanel.module.css`; commit dfda207
---

# A rounded row highlight has nowhere to put a left rail

Do not keep an `inset Npx 0 0` left-edge marker when a row becomes an inset pill; the rail lands inside the rounded corner and reads as an artefact. Why: keyboard-active and hover sit on different rows at once and still have to be distinguishable. Distinguish by weight of fill instead, and give the stronger fill to the keyboard, since that is the row Enter acts on.
