// The switch span's settle legs (#155 phase 2). A Feature switch waits on the
// same tree and git legs a worktree switch does; before this it was admitted as
// a span and then never closed, so every Feature switch wrote `settled: null`
// after the 5s timeout.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { installAnimationFrame } from "../test/frames";

installAnimationFrame();

const written = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "trace_config") return Promise.resolve({ enabled: true, dir: "/tmp/trace", recipe: "" });
    if (cmd === "trace_write") written.push(...(args.lines as string[]));
    return Promise.resolve(null);
  },
}));
vi.mock("./tracedCore", () => ({ setInvokeRecorder: () => {} }));

const { installTrace, traceSwitchStart, tracePaint, traceSettle, traceFlush } = await import("./perfTrace");
await installTrace();

type Row = { t: string; kind: string; key: string; paint: number | null; settled: number | null };
const rows = (): Row[] =>
  written.map((l) => JSON.parse(l) as Row).filter((r) => r.t === "switch");

beforeEach(() => {
  written.length = 0;
});

describe("traceSettle", () => {
  it("closes a Feature span once both legs land", () => {
    traceSwitchStart("feature", "feature:f1");
    tracePaint();
    traceSettle("tree", "feature:f1");
    traceSettle("git", "feature:f1");
    traceFlush();
    const [row] = rows();
    expect(row.kind).toBe("feature");
    expect(typeof row.paint).toBe("number");
    expect(typeof row.settled).toBe("number");
  });

  it("ignores a leg reported against another key, and a tab span has no legs", () => {
    traceSwitchStart("worktree", "/w/api");
    tracePaint();
    traceSettle("tree", "/w/other");
    traceSettle("git", "/w/api");
    traceFlush();
    expect(rows()).toEqual([]);

    // Opening the next span flushes the unsettled one, which is how a switch
    // that never settles still leaves a row.
    traceSwitchStart("tab", "t1");
    traceFlush();
    const worktree = rows().find((r) => r.key === "/w/api")!;
    expect(worktree.settled).toBeNull();
    traceSettle("tree", "t1");
    traceSettle("git", "t1");
    traceFlush();
    expect(rows().find((r) => r.key === "t1")?.settled ?? null).toBeNull();
  });
});
