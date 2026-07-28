import { describe, it, expect } from "vitest";
import events from "../../../dev/fixtures/chat/events.json";
import { parseChatEvent } from "../../utils/chatTypes";
import { applyEvent, initialChat, type ToolItem } from "./chatStore";
import { formatDuration, isEditTool, toolDigest, toolPaths, toolRenderer } from "./toolRenderers";

const card = (over: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  id: "tool1",
  toolUseId: "toolu_1",
  turnId: "t1",
  name: "Bash",
  input: { command: "git status" },
  state: "ok",
  approval: null,
  output: null,
  files: [],
  durationMs: null,
  edits: [],
  ...over,
});

describe("toolRenderer", () => {
  it("routes each known tool to the renderer that reads its shape", () => {
    expect(toolRenderer("Bash")).toBe("bash");
    expect(toolRenderer("Read")).toBe("search");
    expect(toolRenderer("Grep")).toBe("search");
    expect(toolRenderer("Edit")).toBe("edit");
    expect(toolRenderer("MultiEdit")).toBe("edit");
    expect(toolRenderer("WebFetch")).toBe("web");
    expect(toolRenderer("Task")).toBe("task");
  });

  // The fallback is the common case, not the error case: a plugin, an MCP
  // server or a future release can name a tool we have never heard of, and a
  // card that threw on one would take the transcript down with it.
  it("falls back for an unknown tool rather than guessing or throwing", () => {
    expect(toolRenderer("mcp__something__weird")).toBe("generic");
    expect(toolRenderer("")).toBe("generic");
    expect(toolRenderer(null)).toBe("generic");
  });

  it("treats exactly the writing tools as having a diff worth fetching", () => {
    expect(isEditTool("Write")).toBe(true);
    expect(isEditTool("NotebookEdit")).toBe(true);
    expect(isEditTool("Read")).toBe(false);
    expect(isEditTool("Bash")).toBe(false);
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
      expect(() => toolRenderer(c.name)).not.toThrow();
      expect(() => toolDigest(c)).not.toThrow();
      expect(() => toolPaths(c)).not.toThrow();
    }
  });
});
