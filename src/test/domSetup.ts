// Shared setup for the `dom` vitest project (see vitest.config.ts).
//
// Unmounts whatever a test rendered, so one test's DOM can never be what the
// next test asserts against. Solid's testing library tracks its own roots, so
// this is the whole of it: no global teardown to keep in sync per suite.
//
// It also fills the two scroll methods jsdom does not implement at all. They are
// pure side effects on a layout jsdom has none of, so a no-op is the whole of
// the right answer - but they are called from `queueMicrotask`, which means the
// missing method surfaces as an *unhandled* error after the test that caused it
// has already passed.
import { afterEach } from "vitest";
import { cleanup } from "@solidjs/testing-library";

Element.prototype.scrollTo ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

afterEach(cleanup);
