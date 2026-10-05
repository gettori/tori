import { describe, it, expect } from "vite-plus/test";
import { isUnderPath, countRunningUnder, isPdfPath, sameCwd, mentionPath } from "./pathScope";

describe("isUnderPath", () => {
  it("matches self and descendants, not siblings or prefixes", () => {
    expect(isUnderPath("/r/personal", "/r/personal")).toBe(true);
    expect(isUnderPath("/r/personal/proj", "/r/personal")).toBe(true);
    expect(isUnderPath("/r/personal/proj/sub", "/r/personal")).toBe(true);
    expect(isUnderPath("/r/personal-old", "/r/personal")).toBe(false); // prefix, not a child
    expect(isUnderPath("/r/other", "/r/personal")).toBe(false);
    expect(isUnderPath("/r/personal/", "/r/personal")).toBe(true); // trailing slash normalized
  });
});

describe("countRunningUnder", () => {
  const sessions = [
    { id: "a", folderPath: "/r/personal/proj" }, // under, running
    { id: "b", folderPath: "/r/personal/proj/deep/sub" }, // subdir under, running
    { id: "c", folderPath: "/r/personal/proj" }, // under, NOT running
    { id: "d", folderPath: "/r/other/proj" }, // sibling space, running
  ];

  it("counts only sessions that are running AND under the space path", () => {
    const running = new Set(["a", "b", "c", "d"].filter((id) => id !== "c"));
    // a + b are under /r/personal and running; c is under but not running; d is a sibling.
    expect(countRunningUnder(sessions, running, "/r/personal")).toBe(2);
  });

  it("does not fall back to matching only rendered (top-level) folders", () => {
    // b lives in a nested subfolder; a prefix match must still count it.
    const running = new Set(["b"]);
    expect(countRunningUnder(sessions, running, "/r/personal")).toBe(1);
  });

  it("is zero when nothing runs under the space", () => {
    const running = new Set(["d"]); // only the sibling space runs
    expect(countRunningUnder(sessions, running, "/r/personal")).toBe(0);
  });
});

describe("isPdfPath", () => {
  it("goes by the extension, whatever case it is written in", () => {
    expect(isPdfPath("/docs/manual.pdf")).toBe(true);
    expect(isPdfPath("/docs/MANUAL.PDF")).toBe(true);
    // Not a PDF: the composers and the two transports read this to decide
    // whether a location is a page or a line, so a near miss would send the
    // agent looking for a page in a TypeScript file.
    expect(isPdfPath("/docs/manual.pdf.ts")).toBe(false);
    expect(isPdfPath("/docs/pdf")).toBe(false);
  });
});

describe("sameCwd", () => {
  it("matches only exact paths, trailing slash normalized", () => {
    expect(sameCwd("/r/personal/proj", "/r/personal/proj")).toBe(true);
    expect(sameCwd("/r/personal/proj/", "/r/personal/proj")).toBe(true);
    expect(sameCwd("/r/personal/proj/sub", "/r/personal/proj")).toBe(false); // nested, not exact
    expect(sameCwd("/r/personal/proj-old", "/r/personal/proj")).toBe(false);
  });
});

describe("mentionPath", () => {
  it("relativizes a path inside the cwd", () => {
    expect(mentionPath("/r/personal/proj/src/foo.ts", "/r/personal/proj")).toBe("src/foo.ts");
  });

  it("leaves a path outside the cwd absolute (e.g. a Docs-tree file)", () => {
    expect(mentionPath("/r/grimoire/docs/personal/proj/notes.md", "/r/personal/proj")).toBe(
      "/r/grimoire/docs/personal/proj/notes.md",
    );
  });

  it("does not treat a sibling with a shared prefix as inside the cwd", () => {
    expect(mentionPath("/r/personal/proj-old/foo.ts", "/r/personal/proj")).toBe("/r/personal/proj-old/foo.ts");
  });

  it("normalizes a trailing slash on cwd", () => {
    expect(mentionPath("/r/personal/proj/src/foo.ts", "/r/personal/proj/")).toBe("src/foo.ts");
  });
});
