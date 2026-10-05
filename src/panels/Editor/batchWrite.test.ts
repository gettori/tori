import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

// The echo-suppression half of any batch the editor writes itself: a cross-file
// rename, or a `WorkspaceEdit` from a server. `isSelfWrite` exists so the editor
// does not read its own saves as somebody else's edits, and its window is sized
// for one save. A rename writes a hundred and fifty files, and if the window
// runs out before the watcher's debounced echo arrives, the tail of the batch
// raises a reload banner on every file it touched.

let held: (() => void) | null = null;
let refuse: string | null = null;
const calls: { path: string; contents: string }[][] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd !== "fs_write_files") return Promise.resolve(null);
    const files = args!.files as { path: string; contents: string }[];
    calls.push(files);
    const settle = () =>
      refuse ? Promise.reject(new Error(refuse)) : Promise.resolve(files.map((f) => f.path));
    // A slow batch, when a test wants to interleave with it.
    return held ? new Promise<string[]>((res, rej) => (held = () => void settle().then(res, rej))) : settle();
  },
}));

const { writeFilesSuppressingEcho } = await import("./batchWrite");
const { isSelfWrite } = await import("../../utils/selfWrites");

beforeEach(() => {
  calls.length = 0;
  held = null;
  refuse = null;
  vi.useRealTimers();
});

const batch = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ path: `/repo/f${i}.ts`, contents: "x" }));

describe("writeFilesSuppressingEcho", () => {
  it("sends the whole set as one call", async () => {
    const files = batch(150);
    const written = await writeFilesSuppressingEcho(files);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(150);
    expect(written).toHaveLength(150);
  });

  it("suppresses the echo for every file, first and last alike", async () => {
    const files = batch(150);
    await writeFilesSuppressingEcho(files);

    // Per-file marking done as each write goes out would have let the first
    // file's window expire long before the batch finished.
    expect(files.every((f) => isSelfWrite(f.path))).toBe(true);
  });

  it("covers an echo that arrives while the batch is still writing", async () => {
    held = () => {};
    const files = batch(3);
    const pending = writeFilesSuppressingEcho(files);

    // The watcher fires for the files already on disk before the call returns.
    expect(files.every((f) => isSelfWrite(f.path))).toBe(true);

    held();
    await pending;
    expect(files.every((f) => isSelfWrite(f.path))).toBe(true);
  });

  it("restarts the window after a slow batch, so a late echo is still ours", async () => {
    // The window opened before the write has been running for as long as the
    // write took; the watcher's own debounce lands a few hundred ms after that.
    // Marking again on the way out is what keeps the last echo inside it.
    vi.useFakeTimers();
    const files = batch(2);
    held = () => {};
    const pending = writeFilesSuppressingEcho(files);
    vi.advanceTimersByTime(1500); // longer than the self-write TTL
    expect(isSelfWrite(files[0].path)).toBe(false);

    held();
    await pending;
    expect(files.every((f) => isSelfWrite(f.path))).toBe(true);
  });

  it("lets a refused write through to the caller rather than swallowing it", async () => {
    // The rename has to hear about this: a batch that wrote nothing must not
    // then dispatch into the editor, or the file on screen shows a rename that
    // exists nowhere else.
    refuse = "/repo/f1.ts is read-only, so nothing was changed.";
    await expect(writeFilesSuppressingEcho(batch(2))).rejects.toThrow("read-only");
    expect(calls).toHaveLength(1);
  });

  it("does not hold the window open after a refused write", async () => {
    // Nothing was written, so no echo is coming. Keeping the suppression alive
    // would swallow a real external edit to one of those paths for a full
    // second - the opposite of what it is for.
    vi.useFakeTimers();
    refuse = "read-only";
    const files = batch(2);
    held = () => {};
    const pending = writeFilesSuppressingEcho(files);
    vi.advanceTimersByTime(1500);
    held();
    await expect(pending).rejects.toThrow();

    expect(files.every((f) => isSelfWrite(f.path))).toBe(false);
  });
});
