import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { organizeForSave, ORGANIZE_TIMEOUT_MS } from "./organizeOnSave";
import type { LspTextEdit } from "./workspaceEdit";

// Two failures, and the module exists for both. One is shared with the
// formatter: a reply applied to a document the user has typed into since
// deletes what they just typed. The other is this path's own: a language server
// can simply not answer, and a ⌘S that waits out a ninety-second server timeout
// is a broken editor.

const FILE = "/repo/a.ts";
const DOC = "import { b } from './b'\nimport { a } from './a'\n\nconst x = a + b\n";

/** A document identity, standing in for `state.doc`, which is compared by
 *  identity and never read. */
const id = (n: number) => ({ doc: n });

const at = (line: number, character: number) => ({ line, character });
const edit = (sl: number, sc: number, el: number, ec: number, newText: string): LspTextEdit => ({
  range: { start: at(sl, sc), end: at(el, ec) },
  newText,
});

/** The two import lines, swapped: what organize-imports actually answers with. */
const SORTED: LspTextEdit[] = [edit(0, 0, 1, 23, "import { a } from './a'\nimport { b } from './b'")];

function agent(over: {
  organize?: () => Promise<LspTextEdit[] | null>;
  current?: () => { text: string; id: unknown } | null;
  delay?: (ms: number) => Promise<void>;
} = {}) {
  const before = { text: DOC, id: id(1) };
  return {
    before,
    deps: {
      organize: over.organize ?? (() => Promise.resolve(SORTED)),
      current: over.current ?? (() => before),
      delay: over.delay,
    },
  };
}

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("organizing what a save writes", () => {
  it("applies the server's edits to the text on its way to disk", async () => {
    const h = agent();

    const out = await organizeForSave(h.deps, FILE, h.before);

    expect(out.kind).toBe("organized");
    expect((out as { text: string }).text).toBe(
      "import { a } from './a'\nimport { b } from './b'\n\nconst x = a + b\n",
    );
  });

  it("discards the reply when the buffer was typed into while the server answered", async () => {
    // The failure this whole module is shaped around: those keystrokes are in
    // no reply, so applying one afterwards deletes work the user just did, as
    // part of a save they asked for.
    const typed = { text: `${DOC}const y = 2\n`, id: id(2) };
    const h = agent({ current: () => typed });

    const out = await organizeForSave(h.deps, FILE, h.before);

    expect(out).toEqual({ kind: "unchanged", text: typed.text });
  });

  it("compares identity, not text, so a same-length edit is still caught", async () => {
    // `const x = a + b` to `const x = a - b` is the same length. Comparing the
    // strings would call that document unchanged and write the server's reply
    // over it.
    const typed = { text: DOC.replace("a + b", "a - b"), id: id(2) };
    const h = agent({ current: () => typed });

    expect(await organizeForSave(h.deps, FILE, h.before)).toEqual({ kind: "unchanged", text: typed.text });
  });

  it("says the file is gone when it was closed mid-request", async () => {
    const h = agent({ current: () => null });
    expect(await organizeForSave(h.deps, FILE, h.before)).toEqual({ kind: "gone" });
  });

  it("saves unchanged when the server has no organize-imports for this file", async () => {
    const h = agent({ organize: () => Promise.resolve(null) });
    expect(await organizeForSave(h.deps, FILE, h.before)).toEqual({ kind: "unchanged", text: DOC });
  });

  it("saves unchanged rather than throwing when the request fails", async () => {
    const h = agent({ organize: () => Promise.reject(new Error("server died")) });
    expect(await organizeForSave(h.deps, FILE, h.before)).toEqual({ kind: "unchanged", text: DOC });
  });

  it("reports no change when the edits amount to nothing", async () => {
    // Otherwise the caller dispatches a no-op into the buffer and puts an empty
    // step in its undo history on every single save.
    const h = agent({ organize: () => Promise.resolve([edit(0, 0, 0, 23, "import { b } from './b'")]) });
    expect(await organizeForSave(h.deps, FILE, h.before)).toEqual({ kind: "unchanged", text: DOC });
  });

  it("refuses the whole edit rather than applying half of it", async () => {
    // Half an organize-imports is a file with a broken import block, which is
    // worse than one that was left alone.
    const h = agent({
      organize: () => Promise.resolve([edit(0, 0, 0, 5, "x"), edit(99, 0, 99, 1, "y")]),
    });

    expect(await organizeForSave(h.deps, FILE, h.before)).toEqual({ kind: "unchanged", text: DOC });
  });

  it("clamps a character past the end of its line rather than dropping the edit", async () => {
    // How a server spells "to the end of this line" when its idea of the line
    // is one character longer than the buffer's.
    const h = agent({ organize: () => Promise.resolve([edit(0, 0, 0, 999, "import { z } from './z'")]) });

    const out = await organizeForSave(h.deps, FILE, h.before);

    expect(out.kind).toBe("organized");
    expect((out as { text: string }).text.startsWith("import { z } from './z'\n")).toBe(true);
  });
});

describe("the bound on how long a save waits", () => {
  it("gives up at two seconds and saves what the user had", async () => {
    vi.useFakeTimers();
    // Never settles, which is what a busy or wedged server looks like from here.
    const h = agent({ organize: () => new Promise<LspTextEdit[] | null>(() => {}) });

    const pending = organizeForSave(h.deps, FILE, h.before);
    await vi.advanceTimersByTimeAsync(ORGANIZE_TIMEOUT_MS);

    expect(await pending, "the save lands, unorganized").toEqual({ kind: "unchanged", text: DOC });
  });

  it("waits the full two seconds and no less, so a merely slow server still lands", async () => {
    vi.useFakeTimers();
    let release: (e: LspTextEdit[] | null) => void = () => {};
    const h = agent({ organize: () => new Promise<LspTextEdit[] | null>((r) => (release = r)) });

    const pending = organizeForSave(h.deps, FILE, h.before);
    await vi.advanceTimersByTimeAsync(ORGANIZE_TIMEOUT_MS - 1);
    release(SORTED);

    expect((await pending).kind).toBe("organized");
  });

  it("is measured in a person's patience, not a server's", () => {
    // Deliberately not `request_timeout_ms`, which is 20 s for TypeScript and
    // 90 s for rust-analyzer and measures the opposite direction. A quit saves
    // every dirty buffer, so that value would hold the window open one full
    // server timeout per file.
    expect(ORGANIZE_TIMEOUT_MS).toBe(2000);
  });
});
