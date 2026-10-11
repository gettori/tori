import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import { expectNoAxeViolations } from "../../test/axe";
import InboxView from "./InboxView";
import { refreshInbox, type ReviewItem } from "../../utils/reviewInbox";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

function item(id: string, score: number, running = false): ReviewItem {
  return {
    unit: { kind: "session", id },
    project: "/work/app",
    folder: "/work/app/.tori/worktrees/feature",
    agent: "claude",
    title: `task ${id}`,
    summary: `finished ${id}`,
    score,
    signals: [{ kind: "lines", count: 240, points: 24 }],
    fromTs: 1_760_000_100,
    toTs: 1_760_000_900,
    running,
  };
}

let listed: ReviewItem[] = [];

beforeEach(() => {
  listed = [item("calm", 12), item("risky", 64), item("busy", 30, true)];
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "review_inbox") return listed;
    if (cmd === "review_mark") {
      const id = (args as { unit: { id: string } }).unit.id;
      listed = listed.filter((i) => i.unit.id !== id);
    }
    return undefined;
  });
});

describe("InboxView", () => {
  it("lists rows in the order Rust ranked them, and Mark reviewed takes one off", async () => {
    listed = [listed[1], listed[2], listed[0]];
    await refreshInbox();
    const { container } = render(() => <InboxView />);
    const titles = () => screen.getAllByText(/^task /).map((el) => el.textContent);
    expect(titles()).toEqual(["task risky", "task busy", "task calm"]);

    fireEvent.click(screen.getAllByRole("button", { name: "Mark reviewed" })[0]);
    await waitFor(() => expect(titles()).toEqual(["task busy", "task calm"]));
    expect(invoke).toHaveBeenCalledWith("review_mark", {
      unit: { kind: "session", id: "risky" },
      toTs: 1_760_000_900,
    });
    await expectNoAxeViolations(container);
  });

  it("will not mark a session that is still working", async () => {
    await refreshInbox();
    render(() => <InboxView />);
    const row = screen.getByText("task busy").closest("li")!;
    const mark = row.querySelector("button:disabled");
    expect(mark?.textContent).toBe("Mark reviewed");
  });
});
