// Shared setup for the `dom` vitest project (see vitest.config.ts).
//
// Unmounts whatever a test rendered, so one test's DOM can never be what the
// next test asserts against. Solid's testing library tracks its own roots, so
// this is the whole of it: no global teardown to keep in sync per suite.
import { afterEach } from "vitest";
import { cleanup } from "@solidjs/testing-library";

afterEach(cleanup);
