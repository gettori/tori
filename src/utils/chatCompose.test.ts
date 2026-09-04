import { describe, it, expect, afterEach } from "vitest";
import {
  attachmentKind,
  checkAttachment,
  chipLabel,
  clearPending,
  diagnosticBlocks,
  dropPending,
  clearComposer,
  draftFor,
  fileMentionBlocks,
  handBackHeldSend,
  hasAutoSend,
  historyFor,
  hunkCommentBlocks,
  labelsSeeded,
  markAutoSend,
  nextLabel,
  pushHistory,
  relabel,
  restoreDraft,
  seedLabels,
  setDraft,
  offerToComposer,
  pendingFor,
  hasSomethingToSend,
  routeFor,
  seedForSend,
  selectionBlocks,
  takeAutoSend,
  takePending,
  MAX_ATTACHMENTS,
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

  it("carries an attachment's label on the mention, and nothing else's", () => {
    expect(fileMentionBlocks("/x/shot.png", "[Image 1]")[0]).toMatchObject({ label: "[Image 1]" });
    expect(fileMentionBlocks("/x/a.ts")[0]).not.toHaveProperty("label");
  });
});

describe("attachment kinds, by extension", () => {
  it("classifies by what a Read tool opens", () => {
    expect(attachmentKind("a.png")).toBe("image");
    expect(attachmentKind("a.JPG")).toBe("image");
    expect(attachmentKind("a.pdf")).toBe("pdf");
    expect(attachmentKind("Makefile", "")).toBe("file");
    expect(attachmentKind("/repo/src/main.rs")).toBe("file");
  });

  // WebKit's guess. The extension is what the agent would go by too.
  it("trusts the extension over the browser's MIME", () => {
    expect(attachmentKind("main.ts", "video/mp2t")).toBe("file");
  });

  it("uses the MIME only for a name with no extension", () => {
    expect(attachmentKind("shot", "image/png")).toBe("image");
    expect(attachmentKind("scan", "application/pdf")).toBe("pdf");
    expect(attachmentKind("clip", "video/mp4")).toBeNull();
  });

  it("has no kind for bytes no Read tool opens", () => {
    expect(attachmentKind("a.mp4")).toBeNull();
    expect(attachmentKind("a.zip")).toBeNull();
  });
});

describe("checkAttachment, per source", () => {
  const CLAUDE = { kinds: ["image", "pdf", "file"] as const, gap: null };
  const ACP_MENTIONS = { kinds: ["file"] as const, gap: null };
  const ACP_UPLOADS = { kinds: [] as const, gap: "This agent cannot read outside its project." };

  it("passes a kind the agent opens, and says which kind it was", () => {
    expect(checkAttachment({ name: "a.pdf", mediaType: "", bytes: 100 }, 0, CLAUDE)).toEqual({ ok: true, kind: "pdf" });
  });

  it("refuses a kind nothing opens and names the ones this agent does", () => {
    const verdict = checkAttachment({ name: "clip.mp4", mediaType: "video/mp4", bytes: 100 }, 0, CLAUDE);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/clip\.mp4.*image, pdf, file/);
  });

  it("lets the same file through as a mention and refuses it as an upload, in the tier's words", () => {
    expect(checkAttachment({ name: "notes.md", mediaType: "", bytes: null }, 0, ACP_MENTIONS)).toEqual({
      ok: true,
      kind: "file",
    });
    const upload = checkAttachment({ name: "notes.md", mediaType: "", bytes: 100 }, 0, ACP_UPLOADS);
    expect(upload).toEqual({ ok: false, reason: ACP_UPLOADS.gap });
  });

  it("caps by kind, so a PDF may be what an image may not", () => {
    const big = 10 * 1024 * 1024;
    expect(checkAttachment({ name: "a.pdf", mediaType: "", bytes: big }, 0, CLAUDE).ok).toBe(true);
    const image = checkAttachment({ name: "a.png", mediaType: "", bytes: big }, 0, CLAUDE);
    expect(image.ok).toBe(false);
    if (!image.ok) expect(image.reason).toMatch(/10\.0MB.*5MB.*image/);
  });

  it("counts the chips already there", () => {
    expect(checkAttachment({ name: "a.png", mediaType: "", bytes: 1 }, MAX_ATTACHMENTS, CLAUDE).ok).toBe(false);
  });
});

describe("attachment labels", () => {
  afterEach(() => clearComposer(SESSION));

  it("numbers per kind and never reuses a number", () => {
    expect(nextLabel(SESSION, "image")).toBe("[Image 1]");
    expect(nextLabel(SESSION, "pdf")).toBe("[PDF 1]");
    expect(nextLabel(SESSION, "image")).toBe("[Image 2]");
    offerToComposer(SESSION, fileMentionBlocks("/x/a.png", "[Image 2]"));
    dropPending(SESSION, pendingFor(SESSION)[0].id);
    expect(nextLabel(SESSION, "image")).toBe("[Image 3]");
  });

  it("renames a chip and every token naming it, including a repeat", () => {
    offerToComposer(SESSION, fileMentionBlocks("/x/a.png", "[Image 1]"));
    setDraft(SESSION, "compare [Image 1] with [Image 10], then [Image 1] again");
    relabel(SESSION, "[Image 1]", "[Image 4]");
    expect(pendingFor(SESSION)[0].block).toMatchObject({ label: "[Image 4]" });
    expect(draftFor(SESSION)).toBe("compare [Image 4] with [Image 10], then [Image 4] again");
  });

  // A chip minted while the transcript was still being read may collide with a
  // number the conversation already holds. It moves up, in every place it is
  // named: the chip, the draft, and a message held to send.
  it("seeds from the transcript and moves a colliding chip above it", () => {
    offerToComposer(SESSION, fileMentionBlocks("/x/a.png", nextLabel(SESSION, "image")));
    setDraft(SESSION, "see [Image 1]");
    markAutoSend(SESSION, "see [Image 1]");
    expect(labelsSeeded(SESSION)).toBe(false);

    seedLabels(SESSION, ["[Image 2]", "[File 1]"]);

    expect(labelsSeeded(SESSION)).toBe(true);
    expect(pendingFor(SESSION)[0].block).toMatchObject({ label: "[Image 3]" });
    expect(draftFor(SESSION)).toBe("see [Image 3]");
    expect(takeAutoSend(SESSION)).toBe("see [Image 3]");
    expect(nextLabel(SESSION, "file")).toBe("[File 2]");
  });

  it("leaves a chip alone when the transcript never used its number", () => {
    offerToComposer(SESSION, fileMentionBlocks("/x/a.png", nextLabel(SESSION, "image")));
    seedLabels(SESSION, ["[PDF 4]"]);
    expect(pendingFor(SESSION)[0].block).toMatchObject({ label: "[Image 1]" });
    expect(nextLabel(SESSION, "pdf")).toBe("[PDF 5]");
  });

  // Removing the chip has to take its token with it: a sentence still saying
  // `[Image 1]` after the attachment is gone names something the turn will not
  // carry, and the agent would go looking for it.
  it("takes the token out of the sentence when its chip is removed", () => {
    offerToComposer(SESSION, fileMentionBlocks("/x/a.png", "[Image 1]"));
    setDraft(SESSION, "look at [Image 1] and at [Image 1] again");
    dropPending(SESSION, pendingFor(SESSION)[0].id);
    expect(draftFor(SESSION)).toBe("look at and at again");
  });

  it("leaves a sentence that never named it exactly as it was", () => {
    offerToComposer(SESSION, fileMentionBlocks("/x/a.png", "[Image 1]"));
    setDraft(SESSION, "have a look at this");
    dropPending(SESSION, pendingFor(SESSION)[0].id);
    expect(draftFor(SESSION)).toBe("have a look at this");
  });

  it("is seeded even by an empty transcript, so a held send is not held forever", () => {
    seedLabels(SESSION, []);
    expect(labelsSeeded(SESSION)).toBe(true);
    expect(nextLabel(SESSION, "image")).toBe("[Image 1]");
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

  // Consuming, so a remount of the seeded tab cannot fire the turn again - and a
  // seeded tab *is* remounted, since a first send replaces the tab record.
  it("answers the held message exactly once", () => {
    setDraft(SESSION, "go");
    seedForSend(SESSION, TARGET);
    expect(takeAutoSend(TARGET)).toBe("go");
    expect(takeAutoSend(TARGET)).toBe(null);
  });

  // The message rather than a flag, because the composer empties itself the
  // moment `onSend` returns: a draft's first send would have nothing left to
  // read back if this only recorded that there had been one.
  it("holds the message itself, so a clear cannot lose it", () => {
    markAutoSend(TARGET, "the first thing");
    setDraft(TARGET, "");
    expect(takeAutoSend(TARGET)).toBe("the first thing");
  });

  // A message held for a session that never opened is handed back, so the
  // deadline and the failure paths can ask without taking it.
  it("reports a held message without consuming it", () => {
    expect(hasAutoSend(TARGET)).toBe(false);
    markAutoSend(TARGET, "go");
    expect(hasAutoSend(TARGET)).toBe(true);
    expect(hasAutoSend(TARGET)).toBe(true);
    expect(takeAutoSend(TARGET)).toBe("go");
    expect(hasAutoSend(TARGET)).toBe(false);
  });

  // An attachment-only send holds an empty string, which is a message: reading
  // it as "nothing held" would strand the chips it was going to carry.
  it("tells an empty held message apart from none", () => {
    markAutoSend(TARGET, "");
    expect(hasAutoSend(TARGET)).toBe(true);
    expect(takeAutoSend(TARGET)).toBe("");
  });

  // The ordinary hand-back: the session never opened, the composer is untouched,
  // and the message is simply there again.
  it("puts a held message back into an untouched composer", () => {
    handBackHeldSend(TARGET, "the first thing");
    expect(draftFor(TARGET)).toBe("the first thing");
  });

  // The composer stays live for the second or so a first send is in flight, so
  // the user can be mid-sentence when it fails. Overwriting that to save the
  // older message would lose the newer one - but leaving the older one nowhere
  // at all would lose a message the user pressed Enter on, and its own send
  // never got as far as recording it. So it goes to recall.
  it("leaves newer typing alone and keeps the held message recallable", () => {
    setDraft(TARGET, "something else entirely");
    handBackHeldSend(TARGET, "the first thing");

    expect(draftFor(TARGET)).toBe("something else entirely");
    expect(historyFor(TARGET)).toContain("the first thing");
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
    expect(takeAutoSend(TARGET)).toBe(null);
  });

  it("numbers moved chips by the destination and rewrites the text to match", () => {
    offerToComposer(TARGET, fileMentionBlocks("/x/first.png", nextLabel(TARGET, "image")));
    offerToComposer(SESSION, fileMentionBlocks("/x/a.png", nextLabel(SESSION, "image")));
    offerToComposer(SESSION, fileMentionBlocks("/x/b.png", nextLabel(SESSION, "image")));
    setDraft(SESSION, "[Image 1] beside [Image 2]");

    expect(seedForSend(SESSION, TARGET)).toBe(true);

    const labels = pendingFor(TARGET).map((p) => (p.block.type === "fileRef" ? p.block.label : null));
    expect(labels).toEqual(["[Image 1]", "[Image 2]", "[Image 3]"]);
    expect(draftFor(TARGET)).toBe("[Image 2] beside [Image 3]");
    expect(takeAutoSend(TARGET)).toBe("[Image 2] beside [Image 3]");
  });

  it("seeds on attachments alone, which is a real thing to send", () => {
    offerToComposer(SESSION, selectionBlocks("/a.ts", 1, 4, "x"));
    expect(seedForSend(SESSION, TARGET)).toBe(true);
    expect(pendingFor(TARGET)).toHaveLength(1);
  });
});

// A chat steer is the first send that can be refused *after* the composer has
// already cleared itself: the session may be waiting on a permission prompt,
// and that answer comes back long after Enter emptied the input. Without this
// the refusal would eat the message it refused.
describe("restoreDraft", () => {
  const SESSION = "s-restore";
  afterEach(() => clearComposer(SESSION));

  it("puts back text whose send did not land", () => {
    setDraft(SESSION, "stop, just summarise");
    setDraft(SESSION, "");
    restoreDraft(SESSION, "stop, just summarise");
    expect(draftFor(SESSION)).toBe("stop, just summarise");
  });

  it("does not overwrite something typed during the round trip", () => {
    // The newer text is what the user is looking at. The older one is still
    // reachable through Up-arrow recall, so nothing is actually lost.
    setDraft(SESSION, "a newer thought");
    restoreDraft(SESSION, "stop, just summarise");
    expect(draftFor(SESSION)).toBe("a newer thought");
  });

  it("restores nothing for an attachment-only send", () => {
    restoreDraft(SESSION, "");
    expect(draftFor(SESSION)).toBe("");
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

  it("leads with the label the prose names an attachment by", () => {
    expect(chipLabel(fileMentionBlocks("/x/deep/shot.png", "[Image 2]")[0])).toBe("[Image 2] shot.png");
  });
});
