---
summary: solid prevent scroll infers a fake scrollbar from jsdom's zero clientWidth, writes invalid css, getComputedStyle throws
status: current
updated: 2026-08-12
source: "Design system foundation: src/lib boundary, Kobalte install, import guard (personal/sway, branch `94-design-system-foundation`, issue #94); `src/test/domSetup.ts:39`; commit e90eba3"
---

# Kobalte's scroll lock writes invalid CSS into jsdom

Do NOT mount a Kobalte overlay in a jsdom test without the root `clientWidth` shim in `src/test/domSetup.ts`. `solid-prevent-scroll` sizes the scrollbar as `window.innerWidth - documentElement.clientWidth`, jsdom answers 1024 and 0, so it infers a 1024px scrollbar and writes `calc(0 + 1024px)` onto `<html>` (the root's computed `padding-right` comes back as a *unitless* `0`). jsdom 30 resolves computed styles for real, so from that point `getComputedStyle` throws for every element under the root and the test dies inside `getByRole` rather than on anything it asserted. The shim reports the root as exactly as wide as its window, which is the true answer for a document with no layout: the library then measures a 0px scrollbar and writes no `calc()` at all. Why: the stack trace is entirely jsdom and `@testing-library`, naming neither Kobalte nor the dialog, so it reads as a query bug.
