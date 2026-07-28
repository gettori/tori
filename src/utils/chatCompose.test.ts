import { describe, it, expect, afterEach } from "vitest";
import {
  chipLabel,
  clearPending,
  diagnosticBlocks,
  dropPending,
  clearComposer,
  draftFor,
  fileMentionBlocks,
  historyFor,
  hunkCommentBlocks,
  pushHistory,
  setDraft,
  offerToComposer,
  pendingFor,
  hasSomethingToSend,
  routeFor,
  seedForSend,
  selectionBlocks,
  takeAutoSend,
  takePending,
} from "./chatCompose";
import { composeDiagnostic, composeHunkComment, composeSelectionMention, type SessionTarget } from "./safeSend";

const SESSION = "s1";
const TARGET: SessionTarget = { sessionId: SESSION, agent: "claude", folderPath: "/work/repo" };

describe("routeFor", () => {
  // The whole point of the split: a chat-hosted session takes the structured
  // route, and everything else keeps the terminal one it has today.
  it("sends a chat-hosted session to the chat route", () => {
    expect(routeFor(SESSION, new Set([SESSION]))).toBe("chat");
  });

  it("sends every other session to the PTY route", () => {
    expect(routeFor(SESSION, new Set(["other"]))).toBe("pty");
    expect(routeFor(SESSION, new Set())).toBe("pty");
  });
});

describe("the block composers keep what the flat wire format loses", () => {
  it("keeps a selection's path, range and text as structure", () => {
    const blocks = selectionBlocks("/work/repo/src/a.ts", 10, 14, "const x = 1;");
    expect(blocks).toEqual([
      { type: "fileRef", path: "/work/repo/src/a.ts", startLine: 10, endLine: 14, text: "const x = 1;" },
    ]);
    // The PTY reading of the same action is still a single mention line.
    expect(composeSelectionMention(TARGET, "/work/repo/src/a.ts", 10, 14)).toBe("@src/a.ts#L10-L14");
  });

  it("keeps a whole-file mention rangeless, since the user named the file", () => {
    expect(fileMentionBlocks("/work/repo/src/a.ts")).toEqual([
      { type: "fileRef", path: "/work/repo/src/a.ts", startLine: null, endLine: null, text: null },
    ]);
  });

  it("splits a hunk comment into the reference and the prose", () => {
    const blocks = hunkCommentBlocks("/work/repo/src/a.ts", 3, 9, "this loop is quadratic");
    expect(blocks[0]).toEqual({
      type: "fileRef",
      path: "/work/repo/src/a.ts",
      startLine: 3,
      endLine: 9,
      text: null,
    });
    expect(blocks[1]).toEqual({ type: "text", text: "this loop is quadratic" });
    expect(composeHunkComment(TARGET, "/work/repo/src/a.ts", 3, 9, "this loop is quadratic")).toContain(
      "In @src/a.ts lines 3-9:",
    );
  });

  it("flattens a diagnostic's multi-line message the way the PTY format does", () => {
    const message = "Type 'string'\n  is not assignable to\n  type 'number'";
    const blocks = diagnosticBlocks("/work/repo/src/a.ts", 4, 4, "error", message);
    expect(blocks[1]).toEqual({
      type: "text",
      text: "error: Type 'string' is not assignable to type 'number'",
    });
    // Same flattening rule as the terminal route, so the two readings say the
    // same thing rather than differing by a newline.
    expect(composeDiagnostic(TARGET, "/work/repo/src/a.ts", 4, 4, "error", message)).toContain(
      "error: Type 'string' is not assignable to type 'number'",
    );
  });
});

describe("the pending composer inbox", () => {
  afterEach(() => clearPending(SESSION));

  it("holds what is offered instead of sending it", () => {
    offerToComposer(SESSION, selectionBlocks("/a.ts", 1, 2, "x"));
    expect(pendingFor(SESSION)).toHaveLength(1);
    expect(pendingFor("someone-else")).toEqual([]);
  });

  it("drops one chip without disturbing an identical sibling", () => {
    offerToComposer(SESSION, selectionBlocks("/a.ts", 1, 2, "x"));
    offerToComposer(SESSION, selectionBlocks("/a.ts", 1, 2, "x"));
    const [first] = pendingFor(SESSION);
    dropPending(SESSION, first.id);
    expect(pendingFor(SESSION)).toHaveLength(1);
    expect(pendingFor(SESSION)[0].id).not.toBe(first.id);
  });

  it("hands the blocks over exactly once when the turn is sent", () => {
    offerToComposer(SESSION, hunkCommentBlocks("/a.ts", 1, 2, "why"));
    expect(takePending(SESSION)).toHaveLength(2);
    expect(takePending(SESSION)).toEqual([]);
  });

  // The insert-only trust boundary: composed content waits to be sent by the
  // person who composed it. Nothing in this module drains itself, and the only
  // way out is `takePending`, which the composer's submit calls.
  it("never empties itself, however many offers arrive", () => {
    offerToComposer(SESSION, selectionBlocks("/a.ts", 1, 2, "x"));
    offerToComposer(SESSION, diagnosticBlocks("/b.ts", 3, 3, "error", "boom"));
    offerToComposer(SESSION, hunkCommentBlocks("/c.ts", 4, 5, "why"));
    expect(pendingFor(SESSION)).toHaveLength(5);
  });

  it("ignores an empty offer rather than showing an empty chip", () => {
    offerToComposer(SESSION, []);
    expect(pendingFor(SESSION)).toEqual([]);
  });
});

describe("the draft and the chips clear together", () => {
  afterEach(() => clearComposer(SESSION));

  it("keeps a draft per session", () => {
    setDraft(SESSION, "half a thought");
    expect(draftFor(SESSION)).toBe("half a thought");
    expect(draftFor("other")).toBe("");
  });

  // A sent turn must not leave chips behind, and a cleared draft must not leave
  // chips either: they are one composer's contents, so they go together.
  it("clears the typed half and the attached half in one call", () => {
    setDraft(SESSION, "text");
    offerToComposer(SESSION, selectionBlocks("/a.ts", 1, 2, "x"));
    clearComposer(SESSION);
    expect(draftFor(SESSION)).toBe("");
    expect(pendingFor(SESSION)).toEqual([]);
  });
});

describe("composer history", () => {
  afterEach(() => clearComposer(SESSION));

  it("records what was sent, newest first", () => {
    pushHistory(SESSION, "first");
    pushHistory(SESSION, "second");
    expect(historyFor(SESSION)).toEqual(["second", "first"]);
  });

  it("does not record blank sends, which an attachment-only turn produces", () => {
    pushHistory(SESSION, "   ");
    expect(historyFor(SESSION)).toEqual([]);
  });

  // Pressing Up to resend the last thing should not need two presses to walk
  // back past the duplicate it just created.
  it("does not record the same message twice in a row", () => {
    pushHistory(SESSION, "again");
    pushHistory(SESSION, "again");
    expect(historyFor(SESSION)).toEqual(["again"]);
  });

  it("stays bounded so a long session's composer is not a second transcript", () => {
    for (let i = 0; i < 60; i++) pushHistory(SESSION, `msg ${i}`);
    expect(historyFor(SESSION)).toHaveLength(50);
    expect(historyFor(SESSION)[0]).toBe("msg 59");
  });
});

describe("send to a new session", () => {
  const TARGET = "s2";
  afterEach(() => {
    clearComposer(SESSION);
    clearComposer(TARGET);
    takeAutoSend(TARGET);
  });

  it("moves the draft and the chips to the new session and marks it to send", () => {
    setDraft(SESSION, "look at this");
    offerToComposer(SESSION, selectionBlocks("/a.ts", 1, 4, "x"));

    expect(seedForSend(SESSION, TARGET)).toBe(true);
    expect(draftFor(TARGET)).toBe("look at this");
    expect(pendingFor(TARGET)).toHaveLength(1);
    // Moved, not copied: leaving them behind would send the same thing twice.
    expect(draftFor(SESSION)).toBe("");
    expect(pendingFor(SESSION)).toEqual([]);
  });

  // Consuming, so a remount of the seeded tab cannot fire the turn again.
  it("answers the auto-send flag exactly once", () => {
    setDraft(SESSION, "go");
    seedForSend(SESSION, TARGET);
    expect(takeAutoSend(TARGET)).toBe(true);
    expect(takeAutoSend(TARGET)).toBe(false);
  });

  // Asked before the tab is opened: a click with nothing to send must not cost
  // a chat tab, a spawned child and a claimed session id.
  it("reports an empty composer as having nothing to send", () => {
    expect(hasSomethingToSend(SESSION)).toBe(false);
    setDraft(SESSION, "   ");
    expect(hasSomethingToSend(SESSION)).toBe(false);
    setDraft(SESSION, "go");
    expect(hasSomethingToSend(SESSION)).toBe(true);
  });

  it("counts attachments alone as something to send", () => {
    offerToComposer(SESSION, selectionBlocks("/a.ts", 1, 4, "x"));
    expect(hasSomethingToSend(SESSION)).toBe(true);
  });

  it("refuses to seed an empty composer rather than opening a blank chat", () => {
    expect(seedForSend(SESSION, TARGET)).toBe(false);
    expect(takeAutoSend(TARGET)).toBe(false);
  });

  it("seeds on attachments alone, which is a real thing to send", () => {
    offerToComposer(SESSION, selectionBlocks("/a.ts", 1, 4, "x"));
    expect(seedForSend(SESSION, TARGET)).toBe(true);
    expect(pendingFor(TARGET)).toHaveLength(1);
  });
});

describe("chipLabel", () => {
  it("names the file and its range, not the whole path", () => {
    expect(chipLabel(selectionBlocks("/work/repo/src/a.ts", 10, 14, "x")[0])).toBe("@a.ts#L10-L14");
  });

  it("collapses a one-line range", () => {
    expect(chipLabel(selectionBlocks("/work/repo/src/a.ts", 10, 10, "x")[0])).toBe("@a.ts#L10");
  });

  it("shows prose as itself", () => {
    expect(chipLabel({ type: "text", text: "why is this here" })).toBe("why is this here");
  });
});
