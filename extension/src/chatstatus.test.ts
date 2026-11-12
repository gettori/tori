import { describe, it, expect } from "vite-plus/test";
import type { ChatEvent } from "../../src/utils/chatTypes";
import { LINE_CAP, lastLine, phaseOf } from "./chatstatus";

const text = (turnId: string, text: string, agentId: string | null = null): ChatEvent => ({
  type: "textDelta",
  sessionId: "s1",
  turnId,
  text,
  agentId,
});

const tool = (turnId: string): ChatEvent =>
  ({ type: "toolCallStarted", sessionId: "s1", turnId, toolUseId: "t", name: "Bash" }) as ChatEvent;

describe("phaseOf", () => {
  it.each([
    ["working", "working"],
    ["needsYou", "needs"],
    ["solid", "done"],
    ["hollow", "done"],
    ["none", "done"],
  ])("reads %s as %s", (dot, phase) => {
    expect(phaseOf({ dot })).toBe(phase);
  });

  it("reads a missing dot as done", () => {
    expect(phaseOf({})).toBe("done");
    expect(phaseOf({ dot: null })).toBe("done");
  });
});

describe("lastLine", () => {
  it("takes the main agent's latest turn and ignores a subagent's text", () => {
    const events = [text("1", "old reply"), text("2", "First.\nDone with the fix."), text("2", "lane text", "a1")];
    expect(lastLine(events)).toBe("Done with the fix.");
  });

  it("joins text blocks split by tool events within a turn", () => {
    const events = [text("1", "Reading the file.\n"), tool("1"), tool("1"), text("1", "Fixed it in **main.ts**.")];
    expect(lastLine(events)).toBe("Fixed it in main.ts.");
  });

  it("skips a closing code block and shows the prose above it", () => {
    const reply = "Run this:\n\n```bash\nnpm test\n```\n";
    expect(lastLine([text("1", reply)])).toBe("Run this:");
  });

  it("gives no line when the tail has no main agent text", () => {
    expect(lastLine([])).toBeNull();
    expect(lastLine([tool("1"), text("1", "lane", "a1")])).toBeNull();
    expect(lastLine([text("1", "```\ncode only\n```")])).toBeNull();
  });

  it("caps a long line", () => {
    const line = lastLine([text("1", "word ".repeat(100))])!;
    expect(line.length).toBe(LINE_CAP);
    expect(line.endsWith("…")).toBe(true);
  });
});
