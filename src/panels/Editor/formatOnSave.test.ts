import { describe, it, expect } from "vitest";
import { formatForSave, type FormatDeps, type FormatResult, type Snapshot } from "./formatOnSave";

// Formatting on save is a subprocess with a person typing into the same
// document while it runs. Almost every test here is about that overlap, because
// the failure mode is not "the file is badly formatted" - it is a save the user
// asked for silently deleting characters they had just typed.

/** A document identity. `Text` is immutable, so a new instance *is* a new
 *  document; these stand in for it without CodeMirror. */
const doc = (text: string): Snapshot => ({ text, id: { text } });

type Agent = {
  deps: FormatDeps;
  reported: string[];
  asked: { path: string; text: string }[];
  /** Release a held formatter run. */
  release: () => void;
};

function agent(opts: {
  reply?: Partial<FormatResult>;
  throws?: string;
  /** What `current()` answers for the path it is asked about. A function so a
   *  test can move the document while the formatter is in flight. */
  current: (path: string) => Snapshot | null;
  hold?: boolean;
}): Agent {
  const reported: string[] = [];
  const asked: { path: string; text: string }[] = [];
  let release = () => {};
  const deps: FormatDeps = {
    format: (path, text) => {
      asked.push({ path, text });
      if (opts.throws) return Promise.reject(new Error(opts.throws));
      const result: FormatResult = {
        text,
        formatter: null,
        error: null,
        ...opts.reply,
      };
      if (!opts.hold) return Promise.resolve(result);
      return new Promise<FormatResult>((resolve) => (release = () => resolve(result)));
    },
    current: opts.current,
    report: (m) => reported.push(m),
  };
  return { deps, reported, asked, release: () => release() };
}

describe("formatForSave", () => {
  it("returns the formatter's output for the buffer to adopt", async () => {
    const before = doc("const  x=1\n");
    const h = agent({
      reply: { text: "const x = 1;\n", formatter: "prettier" },
      current: () => before,
    });
    expect(await formatForSave(h.deps, "/p/a.ts", before)).toEqual({
      kind: "formatted",
      text: "const x = 1;\n",
      formatter: "prettier",
    });
  });

  it("sends the buffer's text, not the file's path alone", async () => {
    const before = doc("unsaved\n");
    const h = agent({ current: () => before });
    await formatForSave(h.deps, "/p/a.ts", before);
    // The point of formatting on save: what is being formatted is not on disk
    // yet, so a formatter pointed at the file would format the old version.
    expect(h.asked).toEqual([{ path: "/p/a.ts", text: "unsaved\n" }]);
  });

  it("says nothing changed when the file was already formatted", async () => {
    const before = doc("const x = 1;\n");
    const h = agent({
      reply: { text: "const x = 1;\n", formatter: "biome" },
      current: () => before,
    });
    const out = await formatForSave(h.deps, "/p/a.ts", before);
    // Not "formatted" with identical text: the caller would dispatch an empty
    // change into the buffer on every save of an already-clean file.
    expect(out).toEqual({ kind: "unchanged", text: "const x = 1;\n", formatter: "biome" });
  });

  it("keeps what was typed while the formatter ran", async () => {
    // The race this whole module exists for. The formatter's output has no idea
    // the user typed anything, so applying it would delete those characters as
    // part of a save.
    const before = doc("const x = 1\n");
    const after = doc("const x = 12\n");
    let now = before;
    const h = agent({
      reply: { text: "const x = 1;\n", formatter: "prettier" },
      current: () => now,
      hold: true,
    });
    const pending = formatForSave(h.deps, "/p/a.ts", before);
    now = after; // typed while the subprocess was running
    h.release();
    expect(await pending).toEqual({
      kind: "unchanged",
      text: "const x = 12\n",
      formatter: "prettier",
    });
  });

  it("catches a same-length edit, which comparing text could not", async () => {
    // `const x = 1` -> `const x = 2` is the same length and the same as far as
    // any cheap check goes. `Text` is immutable, so identity is the only handle
    // CodeMirror offers on "is this still the document I sent?".
    const before = doc("const x = 1\n");
    const sameLength = doc("const x = 2\n");
    let now = before;
    const h = agent({
      reply: { text: "const x = 1;\n", formatter: "biome" },
      current: () => now,
      hold: true,
    });
    const pending = formatForSave(h.deps, "/p/a.ts", before);
    now = sameLength;
    h.release();
    const out = await pending;
    expect(out).toEqual({ kind: "unchanged", text: "const x = 2\n", formatter: "biome" });
  });

  it("does not confuse identical text for the same document", async () => {
    // Type a character and delete it: same text, different `Text` instance, and
    // the formatter's answer is still the one for the document it was given -
    // but the transaction history moved, so the conservative answer is right.
    const before = doc("const x = 1\n");
    let now = before;
    const h = agent({
      reply: { text: "formatted\n", formatter: "biome" },
      current: () => now,
      hold: true,
    });
    const pending = formatForSave(h.deps, "/p/a.ts", before);
    now = doc("const x = 1\n"); // same text, new instance
    h.release();
    expect((await pending).kind).toBe("unchanged");
  });

  it("asks about the file being saved, not about whatever is on screen", async () => {
    // The save that started on `a.ts` has to finish on `a.ts`. A format takes
    // long enough for an ordinary tab click, and answering with the buffer the
    // user switched *to* would have `b.ts`'s text written into `a.ts` - every
    // character of it replaced, as part of a save.
    const a = doc("a's text\n");
    const b = doc("b's text\n");
    const buffers: Record<string, Snapshot> = { "/p/a.ts": a, "/p/b.ts": b };
    const asked: string[] = [];
    const h = agent({
      reply: { text: "formatted a\n", formatter: "biome" },
      current: (path) => {
        asked.push(path);
        return buffers[path] ?? null;
      },
      hold: true,
    });
    const pending = formatForSave(h.deps, "/p/a.ts", a);
    h.release();
    const out = await pending;
    expect(asked).toEqual(["/p/a.ts"]);
    expect(out).toEqual({ kind: "formatted", text: "formatted a\n", formatter: "biome" });
  });

  it("still saves a file that left the screen while it was formatting", async () => {
    // Switching tabs is not closing the tab. The buffer is still open, its text
    // is still the user's, and the save they asked for still has to land.
    const a = doc("a's text\n");
    const h = agent({
      reply: { text: "formatted a\n", formatter: "prettier" },
      // A background buffer: viewless, but its stashed state still answers.
      current: (path) => (path === "/p/a.ts" ? a : null),
      hold: true,
    });
    const pending = formatForSave(h.deps, "/p/a.ts", a);
    h.release();
    expect((await pending).kind).toBe("formatted");
  });

  it("writes nothing when the buffer went away mid-format", async () => {
    const before = doc("x\n");
    let now: Snapshot | null = before;
    const h = agent({
      reply: { text: "y\n", formatter: "biome" },
      current: () => now,
      hold: true,
    });
    const pending = formatForSave(h.deps, "/p/a.ts", before);
    now = null; // the tab closed, or the editor unmounted
    h.release();
    expect(await pending).toEqual({ kind: "gone" });
  });

  it("leaves the text byte-identical when the formatter refuses", async () => {
    // A syntax error mid-edit is the common case. Writing anything but the
    // original here means a save produced a file the user did not type.
    const before = doc("const x = {\n");
    const h = agent({
      reply: { text: "const x = {\n", formatter: "prettier", error: "a.ts:1:12 expected }" },
      current: () => before,
    });
    const out = await formatForSave(h.deps, "/p/a.ts", before);
    expect(out).toEqual({ kind: "unchanged", text: "const x = {\n", formatter: "prettier" });
  });

  it("shows what the formatter said rather than swallowing it", async () => {
    const before = doc("const x = {\n");
    const h = agent({
      reply: { text: before.text, formatter: "prettier", error: "a.ts:1:12 expected }" },
      current: () => before,
    });
    await formatForSave(h.deps, "/p/a.ts", before);
    expect(h.reported).toEqual(["a.ts:1:12 expected }"]);
  });

  it("still reports the refusal when the result was going to be discarded anyway", async () => {
    // The user typed during the format *and* the formatter complained. The
    // complaint is a line number in their file and is the useful half.
    const before = doc("const x = {\n");
    let now = before;
    const h = agent({
      reply: { text: before.text, formatter: "biome", error: "expected }" },
      current: () => now,
      hold: true,
    });
    const pending = formatForSave(h.deps, "/p/a.ts", before);
    now = doc("const x = {}\n");
    h.release();
    await pending;
    expect(h.reported).toEqual(["expected }"]);
  });

  it("saves normally when the project has no formatter", async () => {
    const before = doc("whatever\n");
    const h = agent({ current: () => before });
    const out = await formatForSave(h.deps, "/p/a.txt", before);
    // A null formatter is also what tells the manual command to fall back to
    // the language server.
    expect(out).toEqual({ kind: "unchanged", text: "whatever\n", formatter: null });
    expect(h.reported).toEqual([]);
  });

  it("survives the command itself failing", async () => {
    // The backend rejected the call outright - not a formatter refusing, so
    // there is no formatter output to quote. The save must still happen.
    const before = doc("x\n");
    const h = agent({ throws: "no such command", current: () => before });
    const out = await formatForSave(h.deps, "/p/a.ts", before);
    expect(out).toEqual({ kind: "unchanged", text: "x\n", formatter: null });
    expect(h.reported[0]).toContain("no such command");
  });

  it("reports a failed command once, not twice", async () => {
    const before = doc("x\n");
    const h = agent({ throws: "boom", current: () => before });
    await formatForSave(h.deps, "/p/a.ts", before);
    expect(h.reported).toHaveLength(1);
  });
});
