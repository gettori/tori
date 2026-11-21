import { describe, it, expect } from "vite-plus/test";
import manifest from "../../package.json?raw";
import lockfile from "../../pnpm-lock.yaml?raw";

const REMOVED = ["@kobalte/core", "lucide-solid"];

// Skips this file, which has to name the packages to ban them.
const APP_SOURCES = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>(["../**/*.{ts,tsx}", "../../mobile/src/**/*.{ts,tsx}"], {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).filter(([path]) => path !== "./boundary.test.ts"),
);

describe("the removed UI packages", () => {
  it("scans the whole of src, so a passing run means something", () => {
    // Guards that quietly match nothing pass forever. The floor is deliberately
    // far below the real count: it catches a glob that broke, not a folder that grew.
    expect(Object.keys(APP_SOURCES).length).toBeGreaterThan(100);
    expect(Object.keys(APP_SOURCES)).toContain("../App.tsx");
    expect(Object.keys(APP_SOURCES)).toContain("./layer.ts");
    expect(Object.keys(APP_SOURCES)).toContain("../../mobile/src/Root.tsx");
  });

  it.each(REMOVED)("%s is not named anywhere in the source", (name) => {
    const offenders = Object.entries(APP_SOURCES)
      .filter(([, source]) => source.includes(name))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it.each(REMOVED)("%s is not installed", (name) => {
    expect(manifest).not.toContain(name);
    expect(lockfile).not.toContain(name);
  });
});
