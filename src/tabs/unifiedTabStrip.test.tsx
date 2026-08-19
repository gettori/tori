// The per-pane strip over a heterogeneous item list (plan phase 6). The
// registry is fed artificial descriptors here: what a kind renders belongs to
// the panel suites, and what this file pins is that one bar composes any mix
// of kinds - rows, activation routing, reorder, overflow, the combined trailing
// cluster, and the wrap-skipping ghost.
import { describe, it, expect, beforeEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { pointerClick } from "../test/menus";
import { setTabBarWidth } from "../test/tabLayout";
import { expectNoAxeViolations } from "../test/axe";
import UnifiedTabStrip from "./UnifiedTabStrip";
import { registerKind } from "./registry";
import type { UnifiedTab } from "./unifiedTabs";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const labels: Record<string, string> = {};

function chatTab(id: string, label: string): UnifiedTab {
  labels[id] = label;
  return { kind: "chat", id, workspace: "/w" } as unknown as UnifiedTab;
}

function fileTab(id: string, label: string): UnifiedTab {
  labels[id] = label;
  return { kind: "file", id, workspace: "/w" } as unknown as UnifiedTab;
}

const activated: string[] = [];

beforeEach(() => {
  activated.length = 0;
  registerKind("chat", {
    icon: () => undefined,
    title: (t) => labels[t.id],
    tooltip: (t) => labels[t.id],
    renderMenuItem: (t) => <span>{labels[t.id]}</span>,
    trailing: () => <button type="button">chat-action</button>,
    activate: (t) => activated.push(t.id),
    close: () => {},
  });
  registerKind("file", {
    icon: () => undefined,
    title: (t) => labels[t.id],
    tooltip: (t) => labels[t.id],
    wrapTab: (_t, tab) => <div data-testid="file-wrap">{tab}</div>,
    renderMenuItem: (t) => <span>{labels[t.id]}</span>,
    trailing: () => <button type="button">file-action</button>,
    activate: (t) => activated.push(t.id),
    close: () => {},
  });
});

const MIXED = [chatTab("c1", "claude one"), fileTab("f1", "app.ts"), chatTab("c2", "claude two")];

describe("a mixed strip", () => {
  it("renders every kind's tab through one bar, in list order", () => {
    render(() => (
      <UnifiedTabStrip items={MIXED} activeId="c1" onReorder={() => {}} />
    ));
    const names = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(names).toEqual(["claude one", "app.ts", "claude two"]);
  });

  it("routes activation through the clicked tab's own descriptor", async () => {
    render(() => (
      <UnifiedTabStrip items={MIXED} activeId="c1" onReorder={() => {}} />
    ));
    pointerClick(screen.getByRole("tab", { name: "app.ts" }));
    await waitFor(() => expect(activated).toEqual(["f1"]));
  });

  it("pulls an overflowed tab into view with both kinds' relative order intact", async () => {
    // 500px fits three 120px tabs once the +N button is reserved.
    setTabBarWidth(500);
    const many = [
      chatTab("c1", "chat 1"),
      fileTab("f1", "file 1"),
      chatTab("c2", "chat 2"),
      fileTab("f2", "file 2"),
      chatTab("c3", "chat 3"),
      fileTab("f3", "file 3"),
    ];
    const orders: string[][] = [];
    render(() => (
      <UnifiedTabStrip
        items={many}
        activeId="c1"
       
        onReorder={(next) => orders.push(next.map((t) => t.id))}
      />
    ));
    const more = await screen.findByRole("button", { name: "3 more" });
    pointerClick(more);
    const menu = await waitFor(() => screen.getByRole("menu"));
    pointerClick(screen.getAllByText("file 3").find((el) => menu.contains(el))!);
    // The pick lands in the last visible slot; everything else keeps its order.
    expect(orders[0]).toEqual(["c1", "f1", "f3", "c2", "f2", "c3"]);
    expect(activated).toEqual(["f3"]);
  });
});

describe("the trailing cluster", () => {
  it("draws every registered kind's controls, whatever is active", async () => {
    // Phase 13: a pane offers the same controls whichever of its tabs is in
    // front, so a file tab does not take the terminal's away.
    const [active, setActive] = createSignal<string | null>("c1");
    render(() => <UnifiedTabStrip items={MIXED} activeId={active()} onReorder={() => {}} />);
    expect(screen.getByRole("button", { name: "chat-action" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "file-action" })).toBeTruthy();
    setActive("f1");
    await waitFor(() => expect(screen.getByRole("button", { name: "file-action" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "chat-action" })).toBeTruthy();
  });

  it("draws them in the declared order, not the order the panels registered", () => {
    registerKind("chat", {
      icon: () => undefined,
      title: (t) => labels[t.id],
      tooltip: (t) => labels[t.id],
      renderMenuItem: (t) => <span>{labels[t.id]}</span>,
      trailing: () => <button type="button">chat-action</button>,
      trailingRank: 20,
      activate: (t) => activated.push(t.id),
      close: () => {},
    });
    registerKind("file", {
      icon: () => undefined,
      title: (t) => labels[t.id],
      tooltip: (t) => labels[t.id],
      renderMenuItem: (t) => <span>{labels[t.id]}</span>,
      trailing: () => <button type="button">file-action</button>,
      trailingRank: 10,
      activate: (t) => activated.push(t.id),
      close: () => {},
    });
    render(() => <UnifiedTabStrip items={MIXED} activeId="c1" onReorder={() => {}} />);
    const row = screen
      .getAllByRole("button")
      .map((b) => b.textContent)
      .filter((t) => t === "chat-action" || t === "file-action");
    expect(row).toEqual(["file-action", "chat-action"]);
  });

  it("still draws them while the strip is empty", () => {
    render(() => <UnifiedTabStrip items={[]} activeId={null} onReorder={() => {}} />);
    expect(screen.getByRole("button", { name: "file-action" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "chat-action" })).toBeTruthy();
  });
});

describe("per-kind affordances", () => {
  it("wraps the on-screen tab but not the measuring ghost", () => {
    render(() => (
      <UnifiedTabStrip items={MIXED} activeId="c1" onReorder={() => {}} />
    ));
    // One file tab, rendered twice (row + ghost): the wrap must appear once.
    expect(screen.getAllByTestId("file-wrap")).toHaveLength(1);
  });
});

describe("accessibility", () => {
  it("is clean while mixed, overflowing, and wearing a trailing cluster", async () => {
    setTabBarWidth(500);
    const many = [
      chatTab("c1", "chat 1"),
      fileTab("f1", "file 1"),
      chatTab("c2", "chat 2"),
      fileTab("f2", "file 2"),
      chatTab("c3", "chat 3"),
      fileTab("f3", "file 3"),
    ];
    const { container } = render(() => (
      <UnifiedTabStrip items={many} activeId="c1" onReorder={() => {}} />
    ));
    await screen.findByRole("button", { name: "3 more" });
    await expectNoAxeViolations(container);
  });
});
