import { describe, it, expect } from "vite-plus/test";
import {
  lastReplies,
  planAsReply,
  nextSideNumber,
  restoredDrawer,
  savedSides,
  sideChatOffered,
  withSide,
  withSideClosed,
  withSideReopened,
  withoutSide,
  type Drawer,
  type SideChat,
} from "./sideChats";
import type { ChatItem, ToolItem } from "./chatStore";

const side = (n: number): SideChat => ({ tabId: `side:${n}`, sessionId: `s${n}`, n });
const closed = (n: number): SideChat => ({ ...side(n), restored: true, started: false });
const drawer = (over: Partial<Drawer> = {}): Drawer => ({ sides: [], active: null, closed: [], ...over });

describe("offering a side chat", () => {
  it("needs both a known read-only mode and a fork", () => {
    const readOnly = ["claude", "codex"];
    expect(sideChatOffered(readOnly, "codex", true)).toBe(true);
    expect(sideChatOffered(readOnly, "codex", false)).toBe(false);
    expect(sideChatOffered(readOnly, "opencode", true)).toBe(false);
  });
});

describe("restoring the side drawer", () => {
  it("saves open and closed fork ids, and restores them as resumed sides", () => {
    const saved = savedSides(drawer({ sides: [side(1), side(2), side(3)], active: "side:2", closed: [closed(4)] }));
    expect(saved).toEqual({ sessions: ["s1", "s2", "s3"], active: 1, closed: ["s4"] });
    expect(savedSides(drawer())).toBeUndefined();

    let k = 0;
    const back = restoredDrawer(
      saved!,
      (id) => id !== "s1",
      () => `n${++k}`,
    );
    expect(back.sides).toEqual([
      { tabId: "side:n1", sessionId: "s2", n: 1, restored: true, started: false },
      { tabId: "side:n2", sessionId: "s3", n: 2, restored: true, started: false },
    ]);
    expect(back.closed).toEqual([{ tabId: "side:n3", sessionId: "s4", n: 3, restored: true, started: false }]);
    expect(back.active).toBe("side:n1");
  });

  it("falls back to the last side when the active one is gone", () => {
    const back = restoredDrawer(
      { sessions: ["s1", "s2"], active: 1 },
      (id) => id === "s1",
      () => "x",
    );
    expect(back.active).toBe("side:x");
  });
});

describe("the side drawer", () => {
  it("opens a side chat as the active tab, in number order", () => {
    expect(withSide(withSide(drawer(), side(2)), side(1))).toEqual(
      drawer({ sides: [side(1), side(2)], active: "side:1" }),
    );
    expect(nextSideNumber(drawer({ sides: [side(1)], closed: [closed(3)] }))).toBe(4);
  });

  it("hands the active tab to the right neighbour, then the left, on close", () => {
    const three = drawer({ sides: [side(1), side(2), side(3)], active: "side:2" });
    expect(withoutSide(three, "side:2").active).toBe("side:3");
    expect(withoutSide({ ...three, active: "side:3" }, "side:3").active).toBe("side:2");
    expect(withoutSide(drawer({ sides: [side(1)], active: "side:1" }), "side:1")).toEqual(drawer());
    expect(withoutSide(three, "side:1").active).toBe("side:2");
  });

  it("keeps a closed side listed to resume, and removes it from either list", () => {
    const after = withSideClosed(drawer({ sides: [side(1), side(2)], active: "side:2" }), "side:2");
    expect(after).toEqual(drawer({ sides: [side(1)], active: "side:1", closed: [closed(2)] }));
    expect(withoutSide(after, "side:2")).toEqual(drawer({ sides: [side(1)], active: "side:1" }));
  });

  it("reopens a closed side by resuming it, or as a fresh fork when it never had a turn", () => {
    const shut = drawer({ sides: [side(1)], active: "side:1", closed: [closed(2)] });
    expect(withSideReopened(shut, "side:2", true, () => "new")).toEqual(
      drawer({ sides: [side(1), closed(2)], active: "side:2" }),
    );
    expect(withSideReopened(shut, "side:2", false, () => "new").sides[1]).toEqual({
      tabId: "side:2",
      sessionId: "new",
      n: 2,
    });
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
