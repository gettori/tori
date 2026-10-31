import { describe, it, expect, vi } from "vite-plus/test";
import { render, fireEvent } from "@solidjs/testing-library";
import SessionChips, { grouped, ordered, type RelatedSession } from "./SessionChips";

function s(id: string, over: Partial<RelatedSession> = {}): RelatedSession {
  return {
    id,
    name: id,
    side: "to",
    relation: "spawned",
    state: "idle",
    project: null,
    branch: null,
    lastAt: 0,
    ...over,
  };
}

describe("ordered", () => {
  it("puts live and waiting sessions first, then the most recent", () => {
    const list = [
      s("old", { lastAt: 1 }),
      s("new", { lastAt: 9 }),
      s("busy", { state: "working", lastAt: 0 }),
      s("ask", { state: "needsYou", lastAt: 2 }),
    ];
    expect(ordered(list).map((x) => x.id)).toEqual(["ask", "busy", "new", "old"]);
  });

  it("keeps the chat that started this one first, however quiet it is", () => {
    const list = [
      s("peer", { side: "from", relation: "prompted", state: "working", lastAt: 9 }),
      s("parent", { side: "from" }),
    ];
    expect(ordered(list).map((x) => x.id)).toEqual(["parent", "peer"]);
  });
});

describe("grouped", () => {
  it("sorts sessions into the list's sections and leaves empty ones out", () => {
    const list = [
      s("parent", { side: "from", relation: "spawned" }),
      s("peer", { side: "from", relation: "prompted" }),
      s("child", { side: "to", relation: "madeWorktree" }),
      s("friend", { side: "to", relation: "linked" }),
    ];
    expect(grouped(list).map((g) => [g.title, g.sessions.map((x) => x.id)])).toEqual([
      ["Started this chat", ["parent"]],
      ["Prompted this chat", ["peer"]],
      ["Started from here", ["child"]],
      ["Linked", ["friend"]],
    ]);
  });
});

describe("SessionChips", () => {
  const many = [
    s("up-1", { side: "from" }),
    s("d1", { lastAt: 3 }),
    s("d2", { lastAt: 2 }),
    s("d3", { lastAt: 1 }),
    s("d4", { lastAt: 0 }),
  ];

  it("shows two chips a direction and folds the rest behind +N", () => {
    const { container, getByText } = render(() => <SessionChips sessions={many} />);
    const chips = [...container.querySelectorAll("[data-related-session]")].map((c) =>
      c.getAttribute("data-related-session"),
    );
    expect(chips).toEqual(["up-1", "d1", "d2"]);
    expect(getByText("+2")).toBeTruthy();
  });

  it("opens the session a chip names, but only when there is somewhere to go", () => {
    const open = vi.fn();
    const withHandler = render(() => <SessionChips sessions={many} onOpen={open} />);
    fireEvent.click(withHandler.container.querySelector("[data-related-session='d1']")!);
    expect(open).toHaveBeenCalledWith("d1");

    const bare = render(() => <SessionChips sessions={many} />);
    expect(bare.container.querySelector("[data-related-session='d1']")!.className).toContain("laneStill");
  });
});
