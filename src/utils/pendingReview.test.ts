import { describe, it, expect } from "vite-plus/test";
import {
  anchorFor,
  anchorLabel,
  isSelfAuthored,
  rowSide,
  submitBlock,
  SELF_AUTHORED_REASON,
  EMPTY_BODY_REASON,
} from "./pendingReview";
import { newSideLines, oldSideLines } from "./reviewThreads";
import { parseDiffHunks } from "./diffHunks";
import { buildRows } from "./diffView";
import type { DraftComment, PullRequest } from "./forgeTypes";

// A hunk covering base lines 10..13 and head lines 10..13, with one line
// replaced. The two numberings agree here only because nothing above changed,
// which is exactly the coincidence a line-only anchor mistakes for a rule.
const HUNK = [
  "@@ -10,4 +10,4 @@ fn main() {",
  " ten",
  "-eleven",
  "+eleven edited",
  " twelve",
  " thirteen",
].join("\n");

const anchorIn = (selected: number[], text = HUNK) => {
  const [hunk] = parseDiffHunks(text);
  return anchorFor({
    path: "src/a.rs",
    rows: buildRows(hunk.lines),
    newLines: newSideLines(hunk),
    oldLines: oldSideLines(hunk),
    selected,
  });
};

describe("rowSide", () => {
  it("counts a removal on the base side and everything else on the head side", () => {
    const rows = buildRows(parseDiffHunks(HUNK)[0].lines);
    expect(rows.map(rowSide)).toEqual(["RIGHT", "LEFT", "RIGHT", "RIGHT", "RIGHT"]);
  });
});

describe("anchorFor", () => {
  it("anchors a single added line on the head side", () => {
    expect(anchorIn([2])).toEqual({
      path: "src/a.rs",
      line: 11,
      side: "RIGHT",
      startLine: null,
      startSide: null,
    });
  });

  it("anchors a removed line on the base side, in the base numbering", () => {
    // Row 1 is `-eleven`: base line 11, and it has no head-side line at all.
    // Sending it as RIGHT:11 would land the comment on `eleven edited`.
    expect(anchorIn([1])).toEqual({
      path: "src/a.rs",
      line: 11,
      side: "LEFT",
      startLine: null,
      startSide: null,
    });
  });

  it("takes the last picked row as the anchor and the first as the range start", () => {
    // GitHub's own convention: `line` is the end of the range.
    expect(anchorIn([2, 3, 4])).toMatchObject({
      line: 13,
      side: "RIGHT",
      startLine: 11,
      startSide: "RIGHT",
    });
  });

  it("reads a selection in any order the same way", () => {
    expect(anchorIn([4, 2, 3])).toEqual(anchorIn([2, 3, 4]));
  });

  it("narrows a selection spanning both sides to the anchor row alone", () => {
    // Rows 1 and 2 are the removal and the addition: two numberings, and no
    // single range the API can express across them. Narrowing is visible
    // because the caller renders the resulting anchor.
    expect(anchorIn([1, 2])).toEqual({
      path: "src/a.rs",
      line: 11,
      side: "RIGHT",
      startLine: null,
      startSide: null,
    });
  });

  it("has no anchor for an empty selection", () => {
    expect(anchorIn([])).toBeNull();
  });
});

describe("anchorLabel", () => {
  const a = (over: Partial<DraftComment> = {}) => ({
    path: "src/a.rs",
    line: 13,
    side: "RIGHT" as const,
    startLine: null,
    startSide: null,
    ...over,
  });

  it("says exactly where the comment will land", () => {
    // Shown because the range can narrow, and a silent narrowing is a comment
    // that lands somewhere other than where it was drawn.
    expect(anchorLabel(a())).toBe("src/a.rs:13");
    expect(anchorLabel(a({ startLine: 11, startSide: "RIGHT" }))).toBe("src/a.rs:11-13");
    expect(anchorLabel(a({ side: "LEFT" }))).toBe("src/a.rs:13 (base)");
  });
});

describe("isSelfAuthored", () => {
  const pr = (author: string) => ({ author }) as PullRequest;

  it("compares the viewer to the author, case-insensitively", () => {
    expect(isSelfAuthored(pr("skarif2"), "skarif2")).toBe(true);
    expect(isSelfAuthored(pr("skarif2"), "SkArif2")).toBe(true);
    expect(isSelfAuthored(pr("skarif2"), "someone-else")).toBe(false);
  });

  it("answers unknown rather than no while the viewer is unknown", () => {
    // The distinction the gate rests on. Read as "no", an unknown viewer offers
    // approve on a pull request the server will refuse with a 422.
    expect(isSelfAuthored(pr("skarif2"), null)).toBeNull();
    expect(isSelfAuthored(pr("skarif2"), "")).toBeNull();
  });
});

describe("submitBlock", () => {
  const comment = (): DraftComment => ({
    path: "src/a.rs",
    line: 11,
    side: "RIGHT",
    startLine: null,
    startSide: null,
    body: "here",
  });

  it("blocks both verdicts on a self-authored pull request", () => {
    const args = { body: "looks good", comments: [], selfAuthored: true, supported: true };
    expect(submitBlock({ ...args, event: "approve" })).toBe(SELF_AUTHORED_REASON);
    expect(submitBlock({ ...args, event: "requestChanges" })).toBe(SELF_AUTHORED_REASON);
    // Comment-only is the one verb GitHub accepts from the author, and on a
    // single-owner repo it is the only review that can ever be left.
    expect(submitBlock({ ...args, event: "comment" })).toBeNull();
  });

  it("blocks a verdict while the viewer is still unknown", () => {
    // Not-yet-known is not known-different. Offering approve here ships a
    // button whose only outcome is a 422.
    const args = { body: "looks good", comments: [], selfAuthored: null, supported: true };
    expect(submitBlock({ ...args, event: "approve" })).toBe(SELF_AUTHORED_REASON);
    expect(submitBlock({ ...args, event: "comment" })).toBeNull();
  });

  it("allows both verdicts on someone else's pull request", () => {
    const args = { body: "looks good", comments: [], selfAuthored: false, supported: true };
    expect(submitBlock({ ...args, event: "approve" })).toBeNull();
    expect(submitBlock({ ...args, event: "requestChanges" })).toBeNull();
  });

  it("refuses request-changes with no summary", () => {
    // The server accepts it. A reader receiving "changes requested" with no
    // word about what to change cannot act on it, which is the actual failure.
    expect(
      submitBlock({ event: "requestChanges", body: "   ", comments: [], selfAuthored: false, supported: true }),
    ).toBe(EMPTY_BODY_REASON);
    expect(
      submitBlock({ event: "requestChanges", body: "fix the leak", comments: [], selfAuthored: false, supported: true }),
    ).toBeNull();
    // Line comments do not substitute: the verdict's own summary is what says
    // what the whole review is asking for.
    expect(
      submitBlock({ event: "requestChanges", body: "", comments: [comment()], selfAuthored: false, supported: true }),
    ).toBe(EMPTY_BODY_REASON);
  });

  it("refuses a comment review with nothing in it", () => {
    expect(submitBlock({ event: "comment", body: "", comments: [], selfAuthored: true, supported: true })).toBeTruthy();
    // Either half is enough on its own.
    expect(
      submitBlock({ event: "comment", body: "", comments: [comment()], selfAuthored: true, supported: true }),
    ).toBeNull();
    expect(submitBlock({ event: "comment", body: "nit", comments: [], selfAuthored: true, supported: true })).toBeNull();
  });

  it("lets an approval carry no words at all", () => {
    // An approval with an empty body is a complete statement; a request for
    // changes with one is not.
    expect(submitBlock({ event: "approve", body: "", comments: [], selfAuthored: false, supported: true })).toBeNull();
  });
});
