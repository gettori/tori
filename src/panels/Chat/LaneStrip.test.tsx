import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import LaneStrip from "./LaneStrip";
import type { Lane } from "./chatStore";

function lane(over: Partial<Lane> = {}): Lane {
  return {
    agentId: "acb01121756a92ca0",
    toolUseId: "toolu_agent",
    agentType: "general-purpose",
    description: "Create one.txt",
    prompt: "Use the Write tool",
    status: null,
    activity: null,
    lastToolName: null,
    usage: null,
    summary: null,
    parentId: null,
    startedAt: Date.now(),
    ...over,
  };
}

const strip = (over: Partial<Parameters<typeof LaneStrip>[0]> = {}) => (
  <LaneStrip lanes={[lane()]} selected={null} onSelect={() => {}} active={true} {...over} />
);

describe("the lane strip", () => {
  it("says nothing at all until a subagent exists", () => {
    // A session that never fans out is the common one, and a row reading "main"
    // alone would be a control with nothing to switch to.
    const { container } = render(() => strip({ lanes: [] }));
    expect(container.textContent).toBe("");
  });

  it("offers main plus one chip per lane", () => {
    const two = [
      lane({ agentId: "a1", description: "Create one.txt" }),
      lane({ agentId: "a2", description: "Create two.txt" }),
    ];
    render(() => strip({ lanes: two }));
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("Create one.txt")).toBeTruthy();
    expect(screen.getByText("Create two.txt")).toBeTruthy();
  });

  it("selects the first subagent on Opt+2, and main on Opt+1", () => {
    const picked: (string | null)[] = [];
    const two = [lane({ agentId: "a1" }), lane({ agentId: "a2" })];
    render(() => strip({ lanes: two, onSelect: (id) => picked.push(id) }));

    // On `code`, not `key`: macOS rewrites the key while Option is held, which
    // is what would make a key-based binding silently never fire.
    fireEvent.keyDown(window, { code: "Digit2", altKey: true });
    fireEvent.keyDown(window, { code: "Digit1", altKey: true });
    expect(picked).toEqual(["a1", null]);

    // Past the end, and without Option: neither is this strip's to answer.
    fireEvent.keyDown(window, { code: "Digit4", altKey: true });
    fireEvent.keyDown(window, { code: "Digit2" });
    expect(picked).toHaveLength(2);
  });

  it("arms the binding only for the chat on screen", () => {
    const picked: (string | null)[] = [];
    render(() => strip({ active: false, onSelect: (id) => picked.push(id) }));
    fireEvent.keyDown(window, { code: "Digit2", altKey: true });
    expect(picked).toEqual([]);
  });

  it("shows elapsed while it runs and its tokens once it has finished", () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      vi.setSystemTime(now);
      const running = lane({ agentId: "a1", description: "running", startedAt: now - 12_000 });
      const done = lane({
        agentId: "a2",
        description: "done",
        status: "completed",
        usage: { totalTokens: 10371, toolUses: 1, durationMs: 5886 },
      });
      render(() => strip({ lanes: [running, done] }));
      expect(screen.getByText("12s")).toBeTruthy();
      expect(screen.getByText("10k")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the elapsed figure moving while the lane runs", () => {
    // The chip used to be built from plain strings, so it showed the figure it
    // was first handed and never moved again. A lane is mutated in place by the
    // store, so nothing else would have caught it.
    vi.useFakeTimers();
    try {
      const now = Date.now();
      vi.setSystemTime(now);
      const { container } = render(() => strip({ lanes: [lane({ startedAt: now })] }));
      expect(container.textContent).toContain("0s");
      vi.advanceTimersByTime(3000);
      expect(container.textContent).toContain("3s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the lane being read", () => {
    render(() => strip({ selected: "acb01121756a92ca0" }));
    const chips = screen.getAllByRole("button");
    expect(chips[0]!.getAttribute("aria-pressed")).toBe("false");
    expect(chips[1]!.getAttribute("aria-pressed")).toBe("true");
  });

  it("switches on a click", () => {
    const picked: (string | null)[] = [];
    render(() => strip({ onSelect: (id) => picked.push(id) }));
    fireEvent.click(screen.getByText("Create one.txt"));
    expect(picked).toEqual(["acb01121756a92ca0"]);
  });

  it("stays clean with two lanes on screen", async () => {
    const { container } = render(() => strip({ lanes: [lane({ agentId: "a1" }), lane({ agentId: "a2" })] }));
    await expectNoAxeViolations(container);
  });
});
