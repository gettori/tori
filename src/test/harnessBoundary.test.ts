import { describe, expect, it } from "vite-plus/test";

const REMOVED = "@solidjs/testing-library";

const SOURCES = Object.entries(
  import.meta.glob<string>(
    [
      "../**/*.{ts,tsx}",
      "../../mobile/src/**/*.{ts,tsx}",
      "../../extension/src/**/*.{ts,tsx}",
      "../../package.json",
      "../../pnpm-lock.yaml",
    ],
    { query: "?raw", import: "default", eager: true },
  ),
).filter(([path]) => !path.endsWith("/harnessBoundary.test.ts"));

describe("the test harness boundary", () => {
  it("scans the app, mobile, the extension, the manifest and the lockfile", () => {
    const paths = SOURCES.map(([path]) => path);
    expect(paths.length).toBeGreaterThan(100);
    expect(paths).toContain("../../package.json");
    expect(paths).toContain("../../pnpm-lock.yaml");
    expect(paths.some((path) => path.startsWith("../../mobile/src/"))).toBe(true);
    expect(paths.some((path) => path.startsWith("../../extension/src/"))).toBe(true);
  });

  it("keeps the removed test library out", () => {
    const offenders = SOURCES.filter(([, source]) => source.includes(REMOVED)).map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
