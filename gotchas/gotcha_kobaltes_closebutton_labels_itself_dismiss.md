---
summary: kobalte's CloseButton carries a default aria label of Dismiss that replaces its accessible name, visible text misses it
status: current
updated: 2026-08-12
source: "Design system foundation: src/lib boundary, Kobalte install, import guard (personal/sway, branch `94-design-system-foundation`, issue #94); `src/lib/dialog.test.tsx:46`; commit e90eba3"
---

# Kobalte's `CloseButton` labels itself "Dismiss"

Do NOT query a Kobalte `Dialog.CloseButton` by the text you rendered into it. It carries a default `aria-label="Dismiss"`, which *replaces* its accessible name, so `getByRole("button", { name: "Close" })` misses a button whose visible text is exactly "Close". A styled wrapper that wants the two to agree has to pass `aria-label` through. Why: the same shape as [[gotcha_an_aria_label_on_a_tab_replaces_its_accessible_name]], except here the label is the library's rather than yours, so nothing in Sway's own code hints that it is there.
