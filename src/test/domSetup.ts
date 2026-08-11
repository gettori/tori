// Shared setup for the `dom` vitest project (see vitest.config.ts).
//
// Unmounts whatever a test rendered, so one test's DOM can never be what the
// next test asserts against. Solid's testing library tracks its own roots, so
// this is the whole of it: no global teardown to keep in sync per suite.
//
// It also fills the three layout methods jsdom does not implement at all. They
// are pure readings of a layout jsdom has none of, so nothing-at-all is the
// whole of the right answer - but they are called from `queueMicrotask` and
// from `requestAnimationFrame`, which means the missing method surfaces as an
// *unhandled* error after the test that caused it has already passed.
import { afterEach } from "vitest";
import { cleanup } from "@solidjs/testing-library";

Element.prototype.scrollTo ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
// CodeMirror measures its own text on the first animation frame after it
// mounts, so any suite holding a real editor past a frame reaches this. An
// empty list is what a zero-sized element genuinely has, and CM6 already reads
// it as "not laid out yet" and keeps its defaults.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;

// The root element's width, for the one library that subtracts it from the
// window's. `solid-prevent-scroll` - which Kobalte's dialog uses to lock the
// page behind an overlay - sizes the scrollbar as
// `window.innerWidth - documentElement.clientWidth`, and jsdom answers 1024
// and 0, so it concludes the page has a 1024px scrollbar to compensate for. It
// then writes `calc(${getComputedStyle(html).paddingRight} + 1024px)`, and
// jsdom reports that padding as a *unitless* `0`, which makes the result
// `calc(0 + 1024px)` - invalid CSS. jsdom 30 resolves computed styles for
// real, so from then on `getComputedStyle` throws for every element under the
// root, and `getByRole` calls it on all of them: a dialog test dies on the
// query rather than on anything it asserted.
//
// Reporting the window's own width is not a workaround but the true answer: a
// document with no layout and no scrollbar has a root exactly as wide as its
// window. The library then measures a 0px scrollbar, skips the compensation
// entirely, and writes no `calc()` at all.
Object.defineProperty(document.documentElement, "clientWidth", {
  configurable: true,
  get: () => window.innerWidth,
});

afterEach(cleanup);
