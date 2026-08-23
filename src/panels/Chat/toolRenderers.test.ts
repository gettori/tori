import { describe, it, expect } from "vitest";
import events from "../../../dev/fixtures/chat/events.json";
import { parseChatEvent } from "../../utils/chatTypes";
import { applyEvent, initialChat, type ToolItem } from "./chatStore";
import { formatDuration, isEditCall, toolDigest, toolPaths, toolRenderer, toolSummaryText } from "./toolRenderers";

const card = (over: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  id: "tool1",
  toolUseId: "toolu_1",
  turnId: "t1",
  name: "Bash",
  title: null,
  toolKind: "execute",
  locations: [],
  input: { command: "git status" },
  state: "ok",
  outputTruncated: false,
  approval: null,
  output: null,
  summary: null,
  files: [],
  durationMs: null,
  edits: [],
  ...over,
});

describe("toolRenderer", () => {
  // Nothing has answered yet, so the kind is the whole of what is known.
  it("picks a body from the kind while the call is still running", () => {
    expect(toolRenderer(card({ toolKind: "execute", summary: null }))).toBe("execute");
    expect(toolRenderer(card({ toolKind: "read", summary: null }))).toBe("read");
    expect(toolRenderer(card({ toolKind: "search", summary: null }))).toBe("search");
    expect(toolRenderer(card({ toolKind: "move", summary: null }))).toBe("edit");
  });

  // The whole reason dispatch moved off the tool name: `Grep` and `Glob` are
  // both `search` calls, and only the result says which body reads them.
  it("lets the result tell a hit list from a path list, with no tool name consulted", () => {
    const grepContent = card({
      name: "Glob",
      toolKind: "search",
      summary: { type: "search", hits: 12, files: 3 },
    });
    const glob = card({
      name: "Grep",
      toolKind: "search",
      summary: { type: "paths", count: 7 },
    });
    expect(toolRenderer(grepContent)).toBe("search");
    expect(toolRenderer(glob)).toBe("paths");
  });

  // The fallback is the common case, not the error case: a plugin, an MCP
  // server or a future release can name a tool we have never heard of, and a
  // card that threw on one would take the transcript down with it.
  it("falls back for a kind it has no body for rather than guessing or throwing", () => {
    expect(toolRenderer(card({ toolKind: "other", summary: null }))).toBe("generic");
    expect(toolRenderer(card({ toolKind: "think", summary: null }))).toBe("generic");
    expect(toolRenderer(card({ toolKind: "switchMode", summary: null }))).toBe("generic");
  });

  it("treats exactly the writing calls as having a diff worth fetching", () => {
    expect(isEditCall(card({ toolKind: "edit", summary: null }))).toBe(true);
    expect(isEditCall(card({ toolKind: "other", summary: { type: "edit", added: 4, removed: 2 } }))).toBe(true);
    expect(isEditCall(card({ toolKind: "read", summary: null }))).toBe(false);
    expect(isEditCall(card({ toolKind: "execute", summary: null }))).toBe(false);
  });
});

describe("toolSummaryText", () => {
  it("says what each kind of result did", () => {
    expect(toolSummaryText({ type: "search", hits: 12, files: 3 })).toBe("12 hits in 3 files");
    expect(toolSummaryText({ type: "paths", count: 7 })).toBe("7 files");
    expect(toolSummaryText({ type: "read", lines: 13, from: 1, total: 400 })).toBe("13 of 400 lines");
    expect(toolSummaryText({ type: "execute", exitCode: 1, lines: 118 })).toBe("exit 1, 118 lines");
    expect(toolSummaryText({ type: "edit", added: 4, removed: 2 })).toBe("+4 -2");
    expect(toolSummaryText({ type: "fetch", host: "example.com", status: 200, bytes: 559 })).toBe("200, 559 B");
  });

  // The absent halves are what actually ships: Claude reports no exit code at
  // all, and `Grep` in content mode reports no usable file count.
  it("says the half it has when the other is not reported", () => {
    expect(toolSummaryText({ type: "search", hits: 12, files: null })).toBe("12 hits");
    expect(toolSummaryText({ type: "read", lines: 40, from: 1, total: null })).toBe("40 lines");
    expect(toolSummaryText({ type: "execute", exitCode: null, lines: 118 })).toBe("118 lines");
    expect(toolSummaryText({ type: "fetch", host: "example.com", status: null, bytes: 4096 })).toBe("4.0 KB");
    expect(toolSummaryText({ type: "fetch", host: "example.com", status: null, bytes: null })).toBe("");
  });

  it("counts in the singular where the number is one", () => {
    expect(toolSummaryText({ type: "search", hits: 1, files: 1 })).toBe("1 hit in 1 file");
    expect(toolSummaryText({ type: "paths", count: 1 })).toBe("1 file");
  });

  // A command that printed nothing is a result, not a missing one.
  it("distinguishes a command that printed nothing from a call with no summary", () => {
    expect(toolSummaryText({ type: "execute", exitCode: 0, lines: 0 })).toBe("no output");
    expect(toolSummaryText(null)).toBe("");
  });
});

describe("toolDigest", () => {
  it("picks the argument that distinguishes one call from another", () => {
    expect(toolDigest(card())).toBe("git status");
    expect(toolDigest(card({ name: "Read", input: { file_path: "/a.rs" } }))).toBe("/a.rs");
    expect(toolDigest(card({ name: "Grep", input: { pattern: "fn main" } }))).toBe("fn main");
    expect(toolDigest(card({ name: "Task", input: { description: "find it" } }))).toBe("find it");
  });

  it("renders as just the tool name when nothing identifies the call", () => {
    expect(toolDigest(card({ input: null }))).toBe("");
    expect(toolDigest(card({ input: { unknown: 1 } }))).toBe("");
    expect(toolDigest(card({ input: 42 }))).toBe("");
  });
});

describe("toolPaths", () => {
  it("collects the paths a call declared and the ones it turned out to write", () => {
    const c = card({
      name: "Edit",
      input: { file_path: "/a.rs" },
      edits: [{ path: "/b.rs", kind: "modified", beforeBlob: null }],
      files: ["/c.rs"],
    });
    expect(toolPaths(c)).toEqual(["/a.rs", "/b.rs", "/c.rs"]);
  });

  it("does not repeat a path that appears in more than one place", () => {
    const c = card({
      name: "Edit",
      input: { file_path: "/a.rs" },
      edits: [{ path: "/a.rs", kind: "modified", beforeBlob: null }],
      files: ["/a.rs"],
    });
    expect(toolPaths(c)).toEqual(["/a.rs"]);
  });

  // A Grep pattern looks path-shaped and is not one. Linking it would offer to
  // open a file that does not exist.
  it("never mistakes a search pattern for a path", () => {
    expect(toolPaths(card({ name: "Grep", input: { pattern: "src/.*\\.ts" } }))).toEqual([]);
  });

  // ACP publishes locations and no arguments Sway can read, so without these a
  // codex card knows the file it read and cannot offer to open it.
  it("lists the locations an agent declared for a call with no path in its arguments", () => {
    const c = card({
      name: "read",
      input: null,
      locations: [
        { path: "/a.rs", line: 12 },
        { path: "/b.rs", line: null },
      ],
    });
    expect(toolPaths(c)).toEqual(["/a.rs", "/b.rs"]);
  });
});

describe("formatDuration", () => {
  it("says nothing about a call too fast to be worth mentioning", () => {
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(400)).toBe("");
  });

  it("scales the unit to the magnitude", () => {
    expect(formatDuration(2500)).toBe("2.5s");
    expect(formatDuration(120_000)).toBe("2m");
  });
});

// The same file the Rust round-trip test writes. Every tool call the fixture
// contains has to reach a renderer, so a tool named in the contract cannot
// silently have no way to render.
describe("the recorded fixture", () => {
  it("gives every tool call in it a renderer and a card", () => {
    const s = initialChat("s1");
    for (const raw of events as unknown[]) {
      const ev = parseChatEvent(raw);
      if (ev) applyEvent(s, ev);
    }
    const cards = s.items.filter((i): i is ToolItem => i.kind === "tool");
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect(() => toolRenderer(c)).not.toThrow();
      expect(() => toolDigest(c)).not.toThrow();
      expect(() => toolPaths(c)).not.toThrow();
    }
  });
});
