// Guards the one way the accessibility gate can be defeated by accident.
//
// `expectNoAxeViolations` is async and reports by throwing, so a call site that
// forgets `await` schedules the check, returns nothing, and lets the test end
// green. The assertion is still written in the file, still reads as coverage in
// review, and enforces nothing. That is the same false-green this whole harness
// exists to prevent, one level up at the call site.
//
// There is no linter in this project, so nothing else would catch it. This is a
// source scan in the spirit of the other `?raw` scan tests: it reads the test
// files as text and insists every call is awaited, returned, or handed back from
// an arrow (`() => expectNoAxeViolations(x)` inside a `Promise.all`).
import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../**/*.test.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const CALL = "expectNoAxeViolations(";

/** Comments mention the helper by name, and a mention is not a call. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** The call sites in one file, each with the code immediately before it. */
function callSites(source: string): string[] {
  const code = withoutComments(source);
  const sites: string[] = [];
  let from = 0;
  for (;;) {
    const at = code.indexOf(CALL, from);
    if (at === -1) return sites;
    sites.push(code.slice(Math.max(0, at - 40), at).trimEnd());
    from = at + CALL.length;
  }
}

const AWAITED = /(await|return|=>)$/;

describe("every axe assertion is actually awaited", () => {
  it("scans the test files that use the gate", () => {
    // A scan that matched nothing would pass forever while proving nothing.
    const users = Object.entries(sources).filter(([, s]) => s.includes(CALL));
    expect(users.length).toBeGreaterThan(0);
  });

  it("finds no un-awaited call site", () => {
    const floating: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      for (const before of callSites(source)) {
        if (!AWAITED.test(before)) floating.push(`${path}: ...${before}`);
      }
    }
    expect(floating).toEqual([]);
  });
});
