import { describe, it, expect } from "vite-plus/test";
import { lastReplies, planAsReply, withSide, withoutSide, type Drawer } from "./sideChats";
import type { ChatItem, ToolItem } from "./chatStore";

const side = (n: number) => ({ tabId: `side:${n}`, sessionId: `s${n}` });

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
