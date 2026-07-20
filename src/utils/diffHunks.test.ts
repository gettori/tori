import { describe, it, expect } from "vitest";
import { parseDiffHunks } from "./diffHunks";
import { hunkFingerprint } from "./hunkFingerprint";

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

describe("cross-language agreement with the Rust hunk parser", () => {
  // Byte-identical to SHARED_FIXTURE in src-tauri/src/patch.rs, which asserts
  // the same two fingerprints. The backend re-parses the diff and re-derives
  // these before staging, so if the two parsers ever disagree about a hunk's
  // body, staging silently refuses instead of failing loudly here.
  const SHARED_FIXTURE =
    "diff --git a/f.txt b/f.txt\nindex 111..222 100644\n--- a/f.txt\n+++ b/f.txt\n" +
    "@@ -1,3 +1,3 @@\n line 1\n-line 2\n+line 2 EDITED\n line 3\n" +
    "@@ -17,3 +17,3 @@\n line 17\n-line 18\n+line 18 EDITED\n line 19\n";

  it("produces the fingerprints the Rust side locks", () => {
    const hunks = parseDiffHunks(SHARED_FIXTURE);
    expect(hunks).toHaveLength(2);
    expect(hunkFingerprint(hunks[0].header, hunks[0].lines)).toBe("dacccae2");
    expect(hunkFingerprint(hunks[1].header, hunks[1].lines)).toBe("5b3ffd64");
  });

  it("leaves no phantom trailing line on the last hunk", () => {
    // The trailing newline used to survive as an empty body line here but not
    // in Rust's str::lines(), which would have refused every last-hunk stage.
    const hunks = parseDiffHunks(SHARED_FIXTURE);
    expect(hunks[1].lines[hunks[1].lines.length - 1]).toBe(" line 19");
  });

  it("still parses a diff with no trailing newline identically", () => {
    const hunks = parseDiffHunks(SHARED_FIXTURE.trimEnd());
    expect(hunkFingerprint(hunks[1].header, hunks[1].lines)).toBe("5b3ffd64");
  });
});
