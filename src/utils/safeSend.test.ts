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
  composeDiagnostic,
  composeTodo,
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

  it("strips the escape a paste can be broken out of", () => {
    // The payload is wrapped in bracketed paste, and a review comment is
    // written by whoever reviews the pull request. Text carrying the terminator
    // ends the paste early, and every byte after it reaches the agent's prompt
    // as typing rather than as pasted content - which is the whole guarantee
    // this module exists to make.
    expect(sanitizeForSend("nice work\x1b[201~rm -rf /")).toBe("nice work[201~rm -rf /");
    // And a bare escape sequence, which would repaint or reposition the
    // terminal rather than appear in the prompt.
    expect(sanitizeForSend("warn \x1b[31malert")).toBe("warn [31malert");
  });

  it("keeps a tab as the space it stands for, and drops the rest", () => {
    // A tab is real whitespace in quoted code, so deleting it would run two
    // words together. Every other control byte carries no text at all.
    expect(sanitizeForSend("if (x)\tthen")).toBe("if (x) then");
    expect(sanitizeForSend("a\x00b\x07c\x7fd\rE")).toBe("abcdE");
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

describe("composeDiagnostic", () => {
  const target = { sessionCwd: "/repo", folderPath: "/repo" } as Parameters<typeof composeDiagnostic>[0];

  it("puts the mention before the complaint", () => {
    expect(composeDiagnostic(target, "/repo/src/a.ts", 12, 12, "error", "Type 'x' is not assignable")).toBe(
      "@src/a.ts#L12-L12 error: Type 'x' is not assignable",
    );
  });

  it("flattens a multi-line server message", () => {
    // A raw newline would submit the prompt on some agents, breaking the
    // insert-only contract safe-send exists to keep.
    const composed = composeDiagnostic(target, "/repo/a.ts", 1, 1, "error", "Line one.\n  Line two.\n\tLine three.");
    expect(composed).not.toMatch(/[\n\r]/);
    expect(composed).toBe("@a.ts#L1-L1 error: Line one. Line two. Line three.");
  });

  it("uses an absolute path outside the session cwd", () => {
    expect(composeDiagnostic(target, "/elsewhere/b.ts", 3, 4, "warning", "hm")).toBe(
      "@/elsewhere/b.ts#L3-L4 warning: hm",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(composeDiagnostic(target, "/repo/a.ts", 1, 1, "info", "  padded  ")).toBe("@a.ts#L1-L1 info: padded");
  });
});

describe("composeTodo", () => {
  const target = { sessionCwd: "/repo", folderPath: "/repo" } as Parameters<typeof composeTodo>[0];

  it("names the location, then asks for the fix", () => {
    // A TODO is a note to a human, so unlike a diagnostic the line does not say
    // what is wrong: the sentence around it is what turns it into a request.
    expect(composeTodo(target, "/repo/src/a.ts", 42, "TODO", "// TODO wire this up")).toBe(
      "@src/a.ts#L42 Fix this TODO: // TODO wire this up",
    );
  });

  it("carries the tag that matched, not a hard-coded one", () => {
    expect(composeTodo(target, "/repo/a.ts", 3, "FIXME", "leaks")).toBe(
      "@a.ts#L3 Fix this FIXME: leaks",
    );
  });

  it("flattens and trims, so the prompt is never submitted for you", () => {
    const composed = composeTodo(target, "/repo/a.ts", 1, "HACK", "  one\n  two  ");
    expect(composed).not.toMatch(/[\n\r]/);
    expect(composed).toBe("@a.ts#L1 Fix this HACK: one two");
  });

  it("uses an absolute path outside the session cwd", () => {
    expect(composeTodo(target, "/elsewhere/b.ts", 9, "XXX", "hm")).toBe(
      "@/elsewhere/b.ts#L9 Fix this XXX: hm",
    );
  });
});
