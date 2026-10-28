import { describe, it, expect } from "vite-plus/test";
import {
  lastReplies,
  planAsReply,
  restoredDrawer,
  savedSides,
  sideChatOffered,
  withSide,
  withoutSide,
  type Drawer,
} from "./sideChats";
import type { ChatItem, ToolItem } from "./chatStore";

const side = (n: number) => ({ tabId: `side:${n}`, sessionId: `s${n}` });

describe("offering a side chat", () => {
  it("needs both a known read-only mode and a fork", () => {
    const readOnly = ["claude", "codex"];
    expect(sideChatOffered(readOnly, "codex", true)).toBe(true);
    expect(sideChatOffered(readOnly, "codex", false)).toBe(false);
    expect(sideChatOffered(readOnly, "opencode", true)).toBe(false);
  });
});

describe("restoring the side drawer", () => {
  it("saves fork ids in order with the active one, and restores them as resumed tabs", () => {
    const saved = savedSides({ sides: [side(1), side(2), side(3)], active: "side:2" });
    expect(saved).toEqual({ sessions: ["s1", "s2", "s3"], active: 1 });
    expect(savedSides({ sides: [], active: null })).toBeUndefined();

    let n = 0;
    const back = restoredDrawer(
      saved!,
      (id) => id !== "s1",
      () => `n${++n}`,
    );
    expect(back.sides).toEqual([
      { tabId: "side:n1", sessionId: "s2", restored: true, started: false },
      { tabId: "side:n2", sessionId: "s3", restored: true, started: false },
    ]);
    expect(back.active).toBe("side:n1");
  });

  it("falls back to the last side when the active one is gone", () => {
    const back = restoredDrawer(
      { sessions: ["s1", "s2"], active: 1 },
      (id) => id === "s1",
      () => "x",
    );
    expect(back).toEqual({
      sides: [{ tabId: "side:x", sessionId: "s1", restored: true, started: false }],
      active: "side:x",
    });
  });
});

describe("the side drawer", () => {
  it("opens a side chat as the active tab", () => {
    const drawer = withSide(withSide({ sides: [], active: null }, side(1)), side(2));
    expect(drawer).toEqual({ sides: [side(1), side(2)], active: "side:2" });
  });

  it("hands the active tab to the right neighbour, then the left, on close", () => {
    const three: Drawer = { sides: [side(1), side(2), side(3)], active: "side:2" };
    expect(withoutSide(three, "side:2").active).toBe("side:3");
    expect(withoutSide({ ...three, active: "side:3" }, "side:3").active).toBe("side:2");
    expect(withoutSide({ sides: [side(1)], active: "side:1" }, "side:1")).toEqual({ sides: [], active: null });
    expect(withoutSide(three, "side:1").active).toBe("side:2");
  });
});

describe("planAsReply", () => {
  const tool = (over: Partial<ToolItem>): ChatItem =>
    ({ kind: "tool", id: "t1", turnId: "turn", agentId: null, ...over }) as ToolItem;

  it("reads a denied ExitPlanMode's plan as the reply", () => {
    const [reply] = planAsReply([tool({ toolKind: "switchMode", input: { plan: "There is a retry in client.ts." } })]);
    expect(reply).toEqual({
      kind: "text",
      id: "t1",
      turnId: "turn",
      text: "There is a retry in client.ts.",
      agentId: null,
    });
  });

  it("leaves every other call, and an empty plan, as it was", () => {
    const read = tool({ toolKind: "read", input: { plan: "not a plan" } });
    const empty = tool({ toolKind: "switchMode", input: { plan: "  " } });
    expect(planAsReply([read, empty])).toEqual([read, empty]);
  });
});

describe("which side replies can be sent", () => {
  const turns = {
    done: { completed: true, model: null, agentInitiated: false },
    live: { completed: false, model: null, agentInitiated: false },
  };
  const text = (id: string, turnId: string, agentId: string | null = null): ChatItem => ({
    kind: "text",
    id,
    turnId,
    text: id,
    agentId,
  });

  it("is the main agent's last reply of each finished turn, a denied plan included", () => {
    const plan = {
      kind: "tool",
      id: "plan",
      toolUseId: "p",
      turnId: "done",
      agentId: null,
      toolKind: "switchMode",
      input: { plan: "the answer" },
    } as unknown as ToolItem;
    const items = planAsReply([text("first", "done"), plan, text("sub", "done", "task-1"), text("running", "live")]);
    expect([...lastReplies(items, turns)]).toEqual(["plan"]);
  });
});
