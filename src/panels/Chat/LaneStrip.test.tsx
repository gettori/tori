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
    seen: false,
    ...over,
  };
}

const strip = (over: Partial<Parameters<typeof LaneStrip>[0]> = {}) => (
  <LaneStrip
    lanes={[lane()]}
    selected={null}
    blocked={new Set()}
    busy={false}
    mark="claude"
    onSelect={() => {}}
    active={true}
    {...over}
  />
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

  it("says how a lane ended rather than only tinting a dot", () => {
    // Six pixels of colour is not a way to learn that work you were counting on
    // failed, and the agent's own word is the one the reader can act on.
    const ended = [
      lane({ agentId: "a1", description: "one", status: "failed" }),
      lane({ agentId: "a2", description: "two", status: "cancelled" }),
      // Measured on disk: a backgrounded call whose ending was never written.
      lane({ agentId: "a3", description: "three", status: "async_launched" }),
    ];
    render(() => strip({ lanes: ended }));
    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.getByText("cancelled")).toBeTruthy();
    expect(screen.getByText("async_launched")).toBeTruthy();
  });

  it("says which lane is waiting on you", () => {
    const two = [lane({ agentId: "a1", description: "one" }), lane({ agentId: "a2", description: "two" })];
    const { container } = render(() => strip({ lanes: two, blocked: new Set(["a2"]) }));
    expect(screen.getByText("waiting")).toBeTruthy();
    // The one that is merely running still shows its clock, so "waiting" reads
    // as the exception rather than as the row's ordinary state.
    expect(container.textContent).toContain("0s");
  });

  it("gives main the working agent's own hue, and only while it works", () => {
    // Not a fifth status tone: the four say how work ended, and this says whose
    // work it is, the way the tab strip already tints a working mark. Read off
    // `data-mark`, which is what the colour keys on.
    const dots = (c: HTMLElement) => [...c.querySelectorAll("[aria-hidden='true']")];
    const busy = render(() => strip({ busy: true, mark: "claude" }));
    expect(dots(busy.container)[0]!.getAttribute("data-mark")).toBe("claude");
    // The subagent beside it keeps its status tone: one strip, two vocabularies,
    // and only the first chip speaks the second one.
    expect(dots(busy.container)[1]!.getAttribute("data-mark")).toBeNull();
    busy.unmount();

    // At rest main is chrome, so a quiet chat does not wear a brand colour.
    const idle = render(() => strip({ busy: false, mark: "claude" }));
    expect(dots(idle.container)[0]!.getAttribute("data-mark")).toBeNull();
    idle.unmount();

    // And a provider Sway cannot name keeps the neutral accent rather than
    // borrowing a logo's.
    const unnamed = render(() => strip({ busy: true, mark: null }));
    expect(dots(unnamed.container)[0]!.getAttribute("data-mark")).toBeNull();
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
