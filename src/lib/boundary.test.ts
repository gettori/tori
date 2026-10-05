import { describe, it, expect } from "vite-plus/test";

/** Every source file in `src/`, as text, except the ones in this folder.
 *
 *  Vite's own glob rather than `node:fs`, the way `lineEndings.test.ts` does
 *  it, so no `@types/node` is needed and the scan works in either vitest
 *  project. Excluding this folder is the rule itself rather than a convenience:
 *  `lib/` is where importing Kobalte is the entire point, and it happens to
 *  spare this file's own mention of the package name below.
 *
 *  The exclusion tests for a `../` prefix rather than for `../lib/`, because
 *  Vite normalizes each key against the importing file: a sibling arrives as
 *  `./dialog.ts`, never as `../lib/dialog.ts`, so the folder-name form matches
 *  nothing and the guard would report its own re-export as a violation.
 *  Everything the guard is meant to police is a directory up and therefore
 *  keeps its `../`.
 *
 *  Tests outside `lib/` are scanned like anything else. A test that reached
 *  past the wrappers to drive a raw Kobalte part would be asserting on
 *  behaviour no Tori component actually ships. */
const APP_SOURCES = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../**/*.{ts,tsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).filter(([path]) => path.startsWith("../")),
);

describe("the src/lib boundary", () => {
  it("scans the whole of src, so a passing run means something", () => {
    // Guards that quietly match nothing pass forever. The floor is deliberately
    // far below the real count (518 files at the time of writing) - it catches
    // a glob that broke, not a folder that grew.
    expect(Object.keys(APP_SOURCES).length).toBeGreaterThan(100);
    expect(Object.keys(APP_SOURCES)).toContain("../App.tsx");
  });

  it("is the only place that names @kobalte/core", () => {
    // Kobalte is a behaviour library, not Tori's API. Styled components in
    // `src/components/` compose the parts re-exported from `src/lib/` and
    // expose Tori's own props; everything above imports those components. Held
    // that way, replacing the primitives library is an edit to `lib/` and a
    // handful of wrappers rather than to the app.
    const offenders = Object.entries(APP_SOURCES)
      .filter(([, source]) => source.includes("@kobalte/core"))
      .map(([path]) => path.replace(/^\.\.\//, "src/"));

    expect(offenders).toEqual([]);
  });
});
