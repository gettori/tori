import { describe, it, expect } from "vite-plus/test";

// Skips this file, which has to name the package to ban it.
const APP_SOURCES = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../**/*.{ts,tsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).filter(([path]) => path !== "./boundary.test.ts"),
);

describe("the removed primitives library", () => {
  it("scans the whole of src, so a passing run means something", () => {
    // Guards that quietly match nothing pass forever. The floor is deliberately
    // far below the real count: it catches a glob that broke, not a folder that grew.
    expect(Object.keys(APP_SOURCES).length).toBeGreaterThan(100);
    expect(Object.keys(APP_SOURCES)).toContain("../App.tsx");
    expect(Object.keys(APP_SOURCES)).toContain("./layer.ts");
  });

  it("is not named anywhere in src", () => {
    const offenders = Object.entries(APP_SOURCES)
      .filter(([, source]) => source.includes("@kobalte/core"))
      .map(([path]) => path.replace(/^\.\.?\//, "src/"));

    expect(offenders).toEqual([]);
  });
});
