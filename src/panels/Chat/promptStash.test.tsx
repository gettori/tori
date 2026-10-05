import { describe, it, expect, vi, afterEach } from "vite-plus/test";

const DIR = "/home/me/.config/tori/attachments";
let file: Array<Record<string, unknown>> = [];
let failPush = false;
const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === "attachments_dir") return DIR;
  if (cmd === "stash_list") return file;
  if (cmd === "stash_push") {
    if (failPush) throw new Error("disk full");
    file = [...file, args!.entry as Record<string, unknown>];
    return file;
  }
  if (cmd === "stash_take" || cmd === "stash_discard") {
    const entry = file.find((e) => e.id === args!.id) ?? null;
    file = file.filter((e) => e !== entry);
    return cmd === "stash_take" ? { entry, stash: file } : file;
  }
  throw new Error(`unexpected ${cmd}`);
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: [string, Record<string, unknown>?]) => invoke(...a) }));

import { restoreEntry, stashDraft, stashEntries, type StashSources } from "./promptStash";
import {
  clearComposer,
  draftFor,
  fileMentionBlocks,
  nextLabel,
  offerToComposer,
  pendingFor,
  setDraft,
} from "../../utils/chatCompose";

const FROM = "tab-from";
const TO = "tab-to";
const EVERYTHING: StashSources = {
  mentions: { kinds: ["image", "pdf", "file"], gap: null },
  uploads: { kinds: ["image", "pdf", "file"], gap: null },
};
const NO_IMAGES: StashSources = {
  mentions: { kinds: ["file"], gap: null },
  uploads: { kinds: ["pdf", "file"], gap: null },
};

afterEach(() => {
  clearComposer(FROM);
  clearComposer(TO);
  file = [];
  failPush = false;
});

const labels = (key: string) => pendingFor(key).map((p) => (p.block.type === "fileRef" ? p.block.label : null));

function draftWithImage(key: string, text: string) {
  offerToComposer(key, fileMentionBlocks(`${DIR}/h1/shot.png`, "[Image 1]"));
  setDraft(key, text);
}

describe("stashing a draft", () => {
  it("parks the text and chips and leaves the composer empty", async () => {
    draftWithImage(FROM, "compare [Image 1]");
    expect(await stashDraft(FROM)).toBe(true);
    expect(draftFor(FROM)).toBe("");
    expect(pendingFor(FROM)).toEqual([]);
    expect(stashEntries().map((e) => e.text)).toEqual(["compare [Image 1]"]);
  });

  it("hands the draft and chips back when the write fails", async () => {
    draftWithImage(FROM, "compare [Image 1]");
    failPush = true;
    expect(await stashDraft(FROM)).toBe(false);
    expect(draftFor(FROM)).toBe("compare [Image 1]");
    expect(labels(FROM)).toEqual(["[Image 1]"]);
  });
});

describe("restoring an entry", () => {
  it("numbers its labels for the tab it lands in", async () => {
    draftWithImage(FROM, "compare [Image 1]");
    await stashDraft(FROM);
    nextLabel(TO, "image");
    await restoreEntry(TO, stashEntries()[0].id, EVERYTHING);
    expect(labels(TO)).toEqual(["[Image 2]"]);
    expect(draftFor(TO)).toBe("compare [Image 2]");
    expect(stashEntries()).toEqual([]);
  });

  it("keeps a chip the agent cannot open in the stash and takes its token out", async () => {
    offerToComposer(FROM, fileMentionBlocks(`${DIR}/h1/shot.png`, "[Image 1]"));
    offerToComposer(FROM, fileMentionBlocks("/work/repo/notes.md", "[File 1]"));
    setDraft(FROM, "see [Image 1] and [File 1]");
    await stashDraft(FROM);
    await restoreEntry(TO, stashEntries()[0].id, NO_IMAGES);
    expect(labels(TO)).toEqual(["[File 1]"]);
    expect(draftFor(TO)).toBe("see and [File 1]");
    const left = stashEntries();
    expect(left).toHaveLength(1);
    expect(left[0].text).toBe("");
    expect(left[0].chips.map((c) => (c.type === "fileRef" ? c.path : null))).toEqual([`${DIR}/h1/shot.png`]);
  });

  it("puts the entry back untouched when text was typed before it arrived", async () => {
    draftWithImage(FROM, "compare [Image 1]");
    await stashDraft(FROM);
    const id = stashEntries()[0].id;
    const restoring = restoreEntry(TO, id, EVERYTHING);
    setDraft(TO, "typed meanwhile");
    await restoring;
    expect(draftFor(TO)).toBe("typed meanwhile");
    expect(pendingFor(TO)).toEqual([]);
    expect(stashEntries().map((e) => [e.id, e.text])).toEqual([[id, "compare [Image 1]"]]);
  });
});
