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
import { afterEach } from "vite-plus/test";
import { cleanup } from "./harness";
import { installNativeLayers } from "./nativeLayers";
import { installTabLayout, resetTabBarWidth } from "./tabLayout";

Element.prototype.scrollTo ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
// CodeMirror measures its own text on the first animation frame after it
// mounts, so any suite holding a real editor past a frame reaches this. An
// empty list is what a zero-sized element genuinely has, and CM6 already reads
// it as "not laid out yet" and keeps its defaults.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
// A list's gliding highlight observes the list from the frame after it opens,
// and nothing resizes in a document with no layout.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

installNativeLayers();

// The one component whose behaviour is a measurement gets a measurable layout,
// scoped to itself. See `tabLayout.ts` for why the ghost row was answering for
// the strip and why that had to stop.
installTabLayout();

afterEach(cleanup);
afterEach(resetTabBarWidth);
