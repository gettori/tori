import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Reply, Request } from "./highlightQueue";

// A stand-in for the syntax worker, driven by hand: what is under test is how
// the page reads its replies and how it falls back when it misbehaves.
class FakeWorker {
  static last: FakeWorker | null = null;
  static throwOnCreate = false;
  posted: Request[] = [];
  terminated = false;
  private listeners: Record<string, ((e: unknown) => void)[]> = {};
  constructor() {
    if (FakeWorker.throwOnCreate) throw new Error("blocked by CSP");
    FakeWorker.last = this;
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  postMessage(req: Request) {
    this.posted.push(req);
  }
  terminate() {
    this.terminated = true;
  }
  send(data: unknown) {
    for (const fn of this.listeners.message ?? []) fn({ data });
  }
  fail(message: string) {
    for (const fn of this.listeners.error ?? []) fn({ message });
  }
  reply(req: Request, over: Partial<Reply> = {}) {
    this.send({ id: req.id, value: `<i>${req.code}</i>`, ...over });
  }
}

vi.mock("./shikiEngine", () => ({
  init: async () => {},
  canHighlight: () => true,
  isLoaded: () => true,
  loadLang: async () => {},
  toHtml: (code: string) => `<main>${code}</main>`,
  toLines: (code: string) => code.split("\n"),
}));

let warn: { mock: { calls: unknown[][] }; mockRestore(): void };
// Re-importing per test makes solid warn about a second copy of itself.
const fallbacks = () => warn.mock.calls.filter(([m]) => String(m).startsWith("[highlight]"));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  FakeWorker.last = null;
  FakeWorker.throwOnCreate = false;
  vi.stubGlobal("Worker", FakeWorker);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  warn.mockRestore();
});

async function block() {
  const { createRoot } = await import("solid-js");
  const { createHighlight } = await import("./highlight");
  return createRoot(() => createHighlight());
}

describe("highlighting through the syntax worker", () => {
  it("paints the worker's answer, and asks once for a block it already has", async () => {
    const hl = await block();
    expect(hl.html("let a", "ts")).toBeNull();
    const w = FakeWorker.last!;
    w.send({ ready: true });
    w.reply(w.posted[0]);
    expect(hl.html("let a", "ts")).toBe("<i>let a</i>");
    expect(hl.html("let a", "ts")).toBe("<i>let a</i>");
    expect(w.posted).toHaveLength(1);
  });

  it("keeps a streaming block's text current and never loses colour it had", async () => {
    const hl = await block();
    hl.html("let", "ts");
    const w = FakeWorker.last!;
    w.reply(w.posted[0]);
    expect(hl.html("let a", "ts")).toBe("<i>let</i> a");
    expect(hl.html("let a <b", "ts")).toBe("<i>let</i> a &lt;b");
    w.reply(w.posted[1]);
    expect(hl.html("let a <b;", "ts")).toBe("<i>let a</i> &lt;b;");
    w.reply(w.posted[2]);
    expect(hl.html("let a <b;", "ts")).toBe("<i>let a <b</i>;");
  });

  it("extends the per-line form the same way", async () => {
    const hl = await block();
    hl.lines("a\nb", "ts");
    const w = FakeWorker.last!;
    w.reply(w.posted[0], { value: ["<i>a</i>", "<i>b</i>"] });
    expect(hl.lines("a\nbc\nd", "ts")).toEqual(["<i>a</i>", "<i>b</i>c", "d"]);
  });

  it("leaves a language whose grammar failed plain, and stays on the worker", async () => {
    const hl = await block();
    hl.html("x", "cobol");
    const w = FakeWorker.last!;
    w.send({ ready: true });
    w.reply(w.posted[0], { value: undefined, error: "grammar did not load" });
    expect(hl.html("x", "cobol")).toBeNull();
    expect(hl.html("y", "cobol")).toBeNull();
    expect(w.posted).toHaveLength(1);
    expect(fallbacks()).toHaveLength(0);
  });

  it.each([
    ["the worker cannot be created", () => (FakeWorker.throwOnCreate = true), () => {}],
    ["the worker reports init failing", () => {}, () => FakeWorker.last!.send({ failed: "init threw" })],
    ["the script fails to load", () => {}, () => FakeWorker.last!.fail("404")],
    ["the worker never says it is ready", () => {}, () => vi.advanceTimersByTime(10_000)],
  ])("falls back to the main thread and warns when %s", async (_, before, after) => {
    before();
    const hl = await block();
    hl.html("let a", "ts");
    after();
    expect(fallbacks()).toHaveLength(1);
    await vi.waitFor(() => expect(hl.html("let a", "ts")).toBe("<main>let a</main>"));
  });
});
