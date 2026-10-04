import { describe, it, expect, vi } from "vitest";
import { createRoot } from "solid-js";
import { createHighlight, langOfPath, HIGHLIGHT_MAX } from "./highlight";

// The real engine is shiki, imported lazily and asynchronously. What is under
// test here is the policy in front of it, so the engine is a stub that always
// answers. Node has no Worker, so this is the main-thread path.
vi.mock("./shikiEngine", () => ({
  init: async () => {},
  canHighlight: () => true,
  isLoaded: () => true,
  loadLang: async () => {},
  toHtml: (code: string) => `<span>${code}</span>`,
  toLines: (code: string) => code.split("\n").map((l) => `<span>${l}</span>`),
}));

const hl = createRoot(() => createHighlight());

describe("the highlighting cap", () => {
  it("paints a block once the engine is in, and never one this big", async () => {
    await vi.waitFor(() => expect(hl.html("const x = 1;", "ts")).not.toBeNull());

    expect(hl.html("const x = 1;", "ts")).toBe("<span>const x = 1;</span>");
    // 200 KB of anything is pasted output, not code being read, and the pass
    // over it would be the one thing on this path worth feeling.
    expect(hl.html("x".repeat(200_000), "ts")).toBeNull();
    expect(HIGHLIGHT_MAX).toBeLessThan(200_000);
  });

  it("caps the per-line form on the same terms", async () => {
    await vi.waitFor(() => expect(hl.lines("a\nb", "ts")).not.toBeNull());
    expect(hl.lines("a\nb", "ts")).toHaveLength(2);
    expect(hl.lines("x".repeat(200_000), "ts")).toBeNull();
  });
});

describe("langOfPath", () => {
  it("reads the grammar off the file's own name", () => {
    expect(langOfPath("/repo/src/a.tsx")).toBe("tsx");
    expect(langOfPath("/repo/Cargo.toml")).toBe("toml");
  });

  // Shiki bundles most suffixes as aliases already, so only the handful it does
  // not are mapped.
  it("maps the suffixes shiki does not ship under their own name", () => {
    expect(langOfPath("/repo/a.mts")).toBe("ts");
    expect(langOfPath("/repo/a.htm")).toBe("html");
    expect(langOfPath("/repo/x.yml")).toBe("yaml");
  });

  // A dotted directory must not be able to fake a suffix, and a dotfile
  // resolves to its own name rather than to an empty one.
  it("reads the basename, never the path around it", () => {
    expect(langOfPath("/repo/v1.2/Makefile")).toBe("makefile");
    expect(langOfPath("/repo/.zshrc")).toBe("shell");
    expect(langOfPath("/repo/README")).toBe("readme");
  });
});
