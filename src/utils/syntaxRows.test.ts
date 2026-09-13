import { describe, it, expect, vi } from "vitest";
import { overlay, paintRows } from "./syntaxRows";
import { buildRows } from "./diffView";
import { HIGHLIGHT_MAX } from "../panels/Chat/highlight";

// The real engine is Lezer, imported lazily. What is under test here is the
// policy in front of it and the walk back into hunk order, so the engine is a
// stub that tags every token with the line it came from on its own side.
vi.mock("../panels/Editor/syntaxLines", () => ({
  languageForPath: async (path: string) => (path.endsWith(".ts") ? { name: "ts" } : null),
  tokenLines: (text: string) =>
    text.split("\n").map((line, i) =>
      line
        .split(/(\s+)/)
        .filter(Boolean)
        .map((t) => ({ text: t, cls: `L${i}` })),
    ),
}));

const text = (spans: { text: string }[] | null) => spans?.map((s) => s.text).join("");

describe("paintRows", () => {
  const rows = buildRows([" ctx", "-old a", "+new b", "+new c", " tail", "\\ No newline at end of file"]);

  it("answers plain until the engine and the language are in, and never for a path with none", async () => {
    // The first call is what asks for the engine, so it answers null.
    expect(paintRows(rows, "/repo/a.ts")).toBeNull();
    await vi.waitFor(() => expect(paintRows(rows, "/repo/a.ts")).not.toBeNull());
    expect(paintRows(rows, "/repo/notes.txt")).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(paintRows(rows, "/repo/notes.txt")).toBeNull();
    expect(paintRows(rows, "")).toBeNull();
  });

  it("walks each side on its own, without the markers, and skips the meta row", async () => {
    await vi.waitFor(() => expect(paintRows(rows, "/repo/a.ts")).not.toBeNull());
    const painted = paintRows(rows, "/repo/a.ts")!;
    expect(painted.map(text)).toEqual(["ctx", "old a", "new b", "new c", "tail", undefined]);
    // The context rows come from the new side; the deleted row from the old.
    // Their line numbers say which side each was cut from, and where.
    expect(painted.map((p) => p?.[0].cls)).toEqual(["L0", "L1", "L1", "L2", "L3", undefined]);
  });

  it("refuses a side past the cap", async () => {
    await vi.waitFor(() => expect(paintRows(rows, "/repo/a.ts")).not.toBeNull());
    const huge = buildRows(["+" + "x".repeat(HIGHLIGHT_MAX + 1)]);
    expect(paintRows(huge, "/repo/a.ts")).toBeNull();
  });
});

describe("overlay", () => {
  const spans = [
    { text: "const ", cls: null },
    { text: "timeout", cls: "sy-variable" },
    { text: " = ", cls: null },
    { text: "250", cls: "sy-number" },
  ];

  it("marks a whole span changed without cutting it", () => {
    const pieces = overlay(spans, 16, 19);
    expect(pieces.map((p) => p.text)).toEqual(["const ", "timeout", " = ", "250"]);
    expect(pieces.map((p) => p.changed)).toEqual([false, false, false, true]);
    expect(pieces[3].cls).toBe("sy-number");
  });

  it("cuts a span at the run's edges and keeps its class on every piece", () => {
    const pieces = overlay(spans, 2, 8);
    expect(pieces.map((p) => [p.text, p.changed, p.cls])).toEqual([
      ["co", false, null],
      ["nst ", true, null],
      ["ti", true, "sy-variable"],
      ["meout", false, "sy-variable"],
      [" = ", false, null],
      ["250", false, "sy-number"],
    ]);
  });
});
