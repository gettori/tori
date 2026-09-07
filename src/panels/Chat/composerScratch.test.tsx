import { describe, it, expect, vi, beforeEach } from "vitest";

const invokes: { cmd: string; args: Record<string, unknown> }[] = [];
let scratchBroken = false;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    invokes.push({ cmd, args });
    switch (cmd) {
      case "scratch_new":
        return scratchBroken ? Promise.reject(new Error("no dir")) : Promise.resolve("/home/me/.config/sway/scratch/Untitled-4");
      default:
        return Promise.resolve(null);
    }
  },
}));

const { openDraftInEditor, unlinkScratch, mirrorSaved, scratchTabClosed } = await import("./composerScratch");
const { draftFor, setDraft, linkedScratchFor } = await import("../../utils/chatCompose");
const { onWith, OPEN_IN_EDITOR, EDITOR_CLOSE_PATH } = await import("../../utils/events");
const { setBufferAccess } = await import("../Editor/liveBuffers");

const SCRATCH = "/home/me/.config/sway/scratch/Untitled-4";
const argsFor = (cmd: string) => invokes.filter((i) => i.cmd === cmd).map((i) => i.args);

/** Every payload an event carried while the test ran. */
function collect<T>(name: string): T[] {
  const seen: T[] = [];
  onWith<T>(name, (d) => seen.push(d));
  return seen;
}

let n = 0;
let key = "";
beforeEach(() => {
  invokes.length = 0;
  scratchBroken = false;
  // A fresh composer per test: the store is module-level and never reset.
  key = `tab-${++n}`;
});

describe("opening the draft in the editor", () => {
  it("writes the draft to a new scratch file, links it, and opens it", async () => {
    setDraft(key, "a long prompt");
    const opened = collect<{ path: string }>(OPEN_IN_EDITOR);
    expect(await openDraftInEditor(key)).toBe(SCRATCH);
    expect(argsFor("fs_write_file")).toEqual([{ path: SCRATCH, contents: "a long prompt" }]);
    expect(linkedScratchFor(key)).toBe(SCRATCH);
    expect(opened).toEqual([{ path: SCRATCH }]);
  });

  it("links only the composer that asked", async () => {
    await openDraftInEditor(key);
    expect(linkedScratchFor(`${key}-other`)).toBeNull();
  });

  it("links nothing when the file could not be made", async () => {
    scratchBroken = true;
    expect(await openDraftInEditor(key)).toBeNull();
    expect(linkedScratchFor(key)).toBeNull();
    expect(argsFor("fs_write_file")).toEqual([]);
  });
});

describe("while linked", () => {
  it("mirrors a save of the linked file into the draft, and ignores any other path", async () => {
    await openDraftInEditor(key);
    expect(mirrorSaved(key, { path: "/space/proj/a.ts", contents: "nope" })).toBe(false);
    expect(draftFor(key)).toBe("");
    expect(mirrorSaved(key, { path: SCRATCH, contents: "edited in the editor" })).toBe(true);
    expect(draftFor(key)).toBe("edited in the editor");
  });

  it("lets go and removes the file when the editor reports the tab closed", async () => {
    await openDraftInEditor(key);
    await scratchTabClosed(key, { path: "/space/proj/a.ts" });
    expect(linkedScratchFor(key)).toBe(SCRATCH);
    await scratchTabClosed(key, { path: SCRATCH });
    expect(linkedScratchFor(key)).toBeNull();
    // Removed for good, not trashed: the draft store holds the text.
    expect(argsFor("scratch_remove")).toEqual([{ path: SCRATCH }]);
  });

  // The send path and edit here: the tab has to go as well, and asking the
  // editor is the only way, since the tab is its. Its text comes along first,
  // so nothing typed there is lost and no discard prompt is needed.
  it("takes the editor's text, closes the tab without a prompt, then removes the file", async () => {
    setDraft(key, "last save");
    await openDraftInEditor(key);
    const drop = setBufferAccess({
      textOf: (p) => (p === SCRATCH ? "typed after the save" : null),
      isDirty: () => true,
      adopt: () => {},
      patch: () => "absent" as const,
    });
    const closes = collect<{ path: string; discard?: boolean }>(EDITOR_CLOSE_PATH);
    await unlinkScratch(key, { closeTab: true });
    drop();
    expect(draftFor(key)).toBe("typed after the save");
    expect(closes).toEqual([{ path: SCRATCH, discard: true }]);
    expect(linkedScratchFor(key)).toBeNull();
    expect(argsFor("scratch_remove")).toHaveLength(1);
    // The editor's own close report then finds nothing to do.
    await scratchTabClosed(key, { path: SCRATCH });
    expect(argsFor("scratch_remove")).toHaveLength(1);
  });

  it("keeps the mirrored draft when no editor buffer holds the file", async () => {
    setDraft(key, "last save");
    await openDraftInEditor(key);
    await unlinkScratch(key, { closeTab: true });
    expect(draftFor(key)).toBe("last save");
  });

  it("does nothing for a composer that is not linked", async () => {
    const closes = collect<{ path: string }>(EDITOR_CLOSE_PATH);
    await unlinkScratch(key, { closeTab: true });
    expect(closes).toEqual([]);
    expect(argsFor("scratch_remove")).toEqual([]);
  });
});
