import { describe, it, expect, vi } from "vitest";
import {
  sanitizeForSend,
  bracketedPaste,
  sendWithProbeGate,
  composeHunkComment,
  composeSelectionMention,
  QUEUE_TIMEOUT_MS,
  type ProbeState,
  type SessionTarget,
} from "./safeSend";

describe("sanitizeForSend", () => {
  it("collapses multiple lines into one, space-joined", () => {
    expect(sanitizeForSend("line one\nline two\nline three")).toBe("line one line two line three");
  });

  it("collapses surrounding and repeated whitespace around newlines", () => {
    expect(sanitizeForSend("  a  \n\n  b  \r\n c ")).toBe("a b c");
  });

  it("trims a single line with no newlines", () => {
    expect(sanitizeForSend("  already one line  ")).toBe("already one line");
  });

  it("collapses to empty for whitespace-only input", () => {
    expect(sanitizeForSend("  \n \n ")).toBe("");
  });
});

describe("bracketedPaste", () => {
  it("wraps text with bracketed-paste start/end, no trailing Enter", () => {
    expect(bracketedPaste("hello")).toBe("\x1b[200~hello\x1b[201~");
  });
});

describe("composeHunkComment", () => {
  const target: SessionTarget = { sessionId: "s1", agent: "claude", folderPath: "/repo", sessionCwd: "/repo" };

  it("relativizes a file inside the session's cwd", () => {
    expect(composeHunkComment(target, "/repo/src/foo.ts", 12, 15, "fix this")).toBe(
      "In @src/foo.ts lines 12-15: fix this",
    );
  });

  it("keeps a file outside the session's cwd absolute (a Docs-tree file)", () => {
    expect(composeHunkComment(target, "/other/docs/notes.md", 1, 1, "typo")).toBe(
      "In @/other/docs/notes.md lines 1-1: typo",
    );
  });

  it("falls back to folderPath when sessionCwd is unset", () => {
    const noCwd: SessionTarget = { sessionId: "s1", agent: "claude", folderPath: "/repo" };
    expect(composeHunkComment(noCwd, "/repo/a.ts", 3, 3, "note")).toBe("In @a.ts lines 3-3: note");
  });
});

describe("composeSelectionMention", () => {
  // A worktree branch-unit cwd ("/repo/branch-a") is a sibling of the
  // project's ".shared" folder ("/repo/.shared"), not an ancestor of it.
  const target: SessionTarget = { sessionId: "s1", agent: "claude", folderPath: "/repo/branch-a", sessionCwd: "/repo/branch-a" };

  it("mentions a file inside the session's cwd relatively, with a line range", () => {
    expect(composeSelectionMention(target, "/repo/branch-a/src/foo.ts", 5, 9)).toBe("@src/foo.ts#L5-L9");
  });

  it("mentions a Shared-tree buffer (outside the session's cwd) absolutely", () => {
    expect(composeSelectionMention(target, "/repo/.shared/notes.md", 2, 2)).toBe("@/repo/.shared/notes.md#L2-L2");
  });
});

// A fake clock lets the timeout/poll paths run without real wall-clock time.
function fakeDeps(overrides: Partial<{ probe: () => Promise<ProbeState>; write: (t: string) => Promise<void> }>) {
  let clock = 0;
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const now = () => clock;
  return {
    now,
    sleep,
    probe: overrides.probe ?? (async () => "ready" as ProbeState),
    write: overrides.write ?? (async () => {}),
  };
}

describe("sendWithProbeGate", () => {
  it("writes immediately when the probe reports ready on the first check (flush-time re-check)", async () => {
    const write = vi.fn(async () => {});
    const probe = vi.fn(async (): Promise<ProbeState> => "ready");
    const deps = fakeDeps({ probe, write });
    const result = await sendWithProbeGate("hi", deps);
    expect(result).toEqual({ kind: "sent" });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("hi");
  });

  it("re-probes before every write, even after queueing (not-ready then ready)", async () => {
    const states: ProbeState[] = ["not-ready", "not-ready", "ready"];
    const probe = vi.fn(async (): Promise<ProbeState> => states.shift()!);
    const write = vi.fn(async () => {});
    const deps = fakeDeps({ probe, write });
    const result = await sendWithProbeGate("hi", deps);
    expect(result).toEqual({ kind: "sent" });
    expect(probe).toHaveBeenCalledTimes(3);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
  });

  it("refuses immediately when the target is blocked, without waiting for the timeout", async () => {
    const probe = vi.fn(async (): Promise<ProbeState> => "blocked");
    const write = vi.fn(async () => {});
    const deps = fakeDeps({ probe, write });
    const result = await sendWithProbeGate("hi", deps);
    expect(result).toEqual({ kind: "blocked" });
    expect(write).not.toHaveBeenCalled();
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("refuses a send whose target blocks partway through the queue wait", async () => {
    const states: ProbeState[] = ["not-ready", "blocked"];
    const probe = vi.fn(async (): Promise<ProbeState> => states.shift()!);
    const write = vi.fn(async () => {});
    const deps = fakeDeps({ probe, write });
    const result = await sendWithProbeGate("hi", deps);
    expect(result).toEqual({ kind: "blocked" });
    expect(write).not.toHaveBeenCalled();
  });

  it("times out and never writes if the probe never reports ready", async () => {
    const probe = vi.fn(async (): Promise<ProbeState> => "not-ready");
    const write = vi.fn(async () => {});
    const deps = fakeDeps({ probe, write });
    const result = await sendWithProbeGate("hi", deps);
    expect(result).toEqual({ kind: "timeout" });
    expect(write).not.toHaveBeenCalled();
    // The fake clock advanced by real sleep durations, so it should have
    // crossed the queue timeout before giving up.
    expect(deps.now()).toBeGreaterThanOrEqual(QUEUE_TIMEOUT_MS);
  });
});
