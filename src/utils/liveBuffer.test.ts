// The rules behind "the preview renders the buffer": what the store holds, how
// long it holds it, and how the two views of one file hand a reading position
// to each other.
//
// The store's bound is the part worth testing hardest. It holds whole
// documents, so a rule that lets an entry outlive its tab is a leak that grows
// for as long as the session does.
import { describe, it, expect, beforeEach } from "vite-plus/test";

import {
  isMarkdownPath,
  bufferTextOf,
  publishBufferText,
  handOff,
  takeHandOff,
  scrollFraction,
  lineAtFraction,
  fractionOfLine,
  notePreviewAnchor,
  previewAnchorOf,
  boxAt,
  dropLiveBuffer,
  clearLiveBuffers,
} from "./liveBuffer";

const MD = "/space/proj/notes.md";
const TS = "/space/proj/main.ts";

beforeEach(() => {
  clearLiveBuffers();
});

describe("which files have a second view", () => {
  it("recognises markdown whatever case it was written in", () => {
    expect(isMarkdownPath(MD)).toBe(true);
    expect(isMarkdownPath("/a/README.MD")).toBe(true);
  });

  it("says no to everything else, including the other previewable kind", () => {
    // SVG has a preview too, but it renders the file through the asset
    // protocol and never asks for its text, so publishing one would be a
    // document held for no reader.
    expect(isMarkdownPath(TS)).toBe(false);
    expect(isMarkdownPath("/a/logo.svg")).toBe(false);
    expect(isMarkdownPath("/a/md")).toBe(false);
  });
});

describe("what a sibling surface can read", () => {
  it("answers with the text that was published", () => {
    publishBufferText(MD, "# one");
    expect(bufferTextOf(MD)).toBe("# one");
  });

  it("answers undefined for a file no buffer holds", () => {
    // Which is the signal to read the file instead, so it has to be
    // distinguishable from a buffer that genuinely holds an empty document.
    expect(bufferTextOf(MD)).toBeUndefined();
    publishBufferText(MD, "");
    expect(bufferTextOf(MD)).toBe("");
  });

  it("forgets a file outright when its tab closes", () => {
    publishBufferText(MD, "# one");
    dropLiveBuffer(MD);
    expect(bufferTextOf(MD)).toBeUndefined();
  });

  it("forgets everything on a project switch", () => {
    publishBufferText(MD, "# one");
    clearLiveBuffers();
    expect(bufferTextOf(MD)).toBeUndefined();
  });
});

describe("handing a reading position between the two views", () => {
  it("lets the other side pick it up", () => {
    handOff(MD, "source", 0.4);
    expect(takeHandOff(MD, "preview")).toBe(0.4);
  });

  it("refuses to hand a side back its own position", () => {
    // The reason this is a handoff and not a scroll memory. A tab swap and a
    // reopen both come back through the source view, and both must still land
    // on the cursor rather than on wherever the file was last scrolled to.
    handOff(MD, "source", 0.4);
    expect(takeHandOff(MD, "source")).toBeUndefined();
  });

  it("hands it over once", () => {
    handOff(MD, "preview", 0.6);
    expect(takeHandOff(MD, "source")).toBe(0.6);
    expect(takeHandOff(MD, "source")).toBeUndefined();
  });

  it("keeps only the latest, so the last scroll is the one carried", () => {
    handOff(MD, "source", 0.1);
    handOff(MD, "source", 0.8);
    expect(takeHandOff(MD, "preview")).toBe(0.8);
  });

  it("clamps a position that cannot exist", () => {
    handOff(MD, "source", 4);
    expect(takeHandOff(MD, "preview")).toBe(1);
    handOff(MD, "source", -1);
    expect(takeHandOff(MD, "preview")).toBe(0);
  });

  it("drops a pending position with the tab it belonged to", () => {
    handOff(MD, "source", 0.4);
    dropLiveBuffer(MD);
    expect(takeHandOff(MD, "preview")).toBeUndefined();
  });
});

describe("reading a scroll container", () => {
  it("reports how far down it is", () => {
    expect(scrollFraction(50, 300, 100)).toBe(0.25);
  });

  it("declines to answer for a box with nothing to scroll", () => {
    // Also every element under jsdom, which measures everything as zero. An
    // answer here would be a division by zero recorded as a real position.
    expect(scrollFraction(0, 100, 100)).toBeUndefined();
    expect(scrollFraction(0, 0, 0)).toBeUndefined();
  });

  it("stays inside the range when the browser overscrolls", () => {
    expect(scrollFraction(400, 300, 100)).toBe(1);
  });
});

describe("turning a position into a line", () => {
  it("puts the top of the file at zero and the end at one", () => {
    expect(lineAtFraction(0, 100)).toBe(1);
    expect(lineAtFraction(1, 100)).toBe(100);
  });

  it("lands in the middle for the middle", () => {
    expect(lineAtFraction(0.5, 101)).toBe(51);
  });

  it("survives a document too short to have a middle", () => {
    expect(lineAtFraction(0.5, 1)).toBe(1);
    expect(lineAtFraction(0.5, 0)).toBe(1);
  });

  it("round-trips, so neither view drifts by describing where it already is", () => {
    for (const line of [1, 37, 100]) {
      expect(lineAtFraction(fractionOfLine(line, 100), 100)).toBe(line);
    }
  });

  it("describes a one-line document as the top of it", () => {
    expect(fractionOfLine(1, 1)).toBe(0);
    expect(fractionOfLine(1, 0)).toBe(0);
  });
});

describe("remembering where the preview was read", () => {
  it("gives back what the preview noted", () => {
    notePreviewAnchor(MD, { box: 12, offset: 40 });
    expect(previewAnchorOf(MD)).toEqual({ box: 12, offset: 40 });
  });

  it("is not the hand off, so the source taking its position leaves it alone", () => {
    notePreviewAnchor(MD, { box: 3, offset: 0 });
    handOff(MD, "preview", 0.6);
    expect(takeHandOff(MD, "source")).toBe(0.6);
    expect(previewAnchorOf(MD)).toEqual({ box: 3, offset: 0 });
  });

  it("goes with the tab it belonged to", () => {
    notePreviewAnchor(MD, { box: 3, offset: 0 });
    dropLiveBuffer(MD);
    expect(previewAnchorOf(MD)).toBeUndefined();
  });
});

describe("finding the block on screen", () => {
  // Three 100px boxes stacked from zero.
  const bottom = (i: number) => (i + 1) * 100;

  it("names the first box at the very top", () => {
    expect(boxAt(3, bottom, 0)).toBe(0);
  });

  it("names the box the line falls inside", () => {
    expect(boxAt(3, bottom, 150)).toBe(1);
    // A box whose bottom is exactly at the line is already above it.
    expect(boxAt(3, bottom, 200)).toBe(2);
  });

  it("names the last box when the line is past them all", () => {
    expect(boxAt(3, bottom, 900)).toBe(2);
  });

  it("names nothing in an empty document", () => {
    expect(boxAt(0, bottom, 0)).toBe(-1);
  });
});
