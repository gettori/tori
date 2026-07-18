import { describe, it, expect } from "vitest";
import { parseDiffHunks } from "./diffHunks";

const SAMPLE = `diff --git a/foo.ts b/foo.ts
index abc..def 100644
--- a/foo.ts
+++ b/foo.ts
@@ -10,2 +10,3 @@ function foo() {
 context line
+added line
 another context
@@ -40,1 +41,0 @@ function bar() {
-removed line`;

describe("parseDiffHunks", () => {
  it("groups lines under their nearest preceding hunk header", () => {
    const hunks = parseDiffHunks(SAMPLE);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].lines).toEqual([" context line", "+added line", " another context"]);
    expect(hunks[1].lines).toEqual(["-removed line"]);
  });

  it("derives the new-file line range from the '+' side of the header", () => {
    const hunks = parseDiffHunks(SAMPLE);
    expect(hunks[0]).toMatchObject({ startLine: 10, endLine: 12 });
  });

  it("a pure-deletion hunk (zero new-file count) keeps a single-line range", () => {
    const hunks = parseDiffHunks(SAMPLE);
    expect(hunks[1]).toMatchObject({ startLine: 41, endLine: 41 });
  });

  it("ignores diff --git/index/---/+++ preamble lines outside any hunk", () => {
    const hunks = parseDiffHunks(SAMPLE);
    expect(hunks.every((h) => !h.lines.some((l) => l.startsWith("diff ") || l.startsWith("index")))).toBe(true);
  });

  it("returns no hunks for text with no @@ headers", () => {
    expect(parseDiffHunks("just some text\nno headers here")).toEqual([]);
  });
});
