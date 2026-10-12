import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import { expectNoAxeViolations } from "../../test/axe";
import InboxView from "./InboxView";
import { refreshInbox } from "../../utils/reviewInbox";
import { refreshNeedsYou } from "../../utils/needsYouInbox";
import type { NeedsYouEvent } from "../../utils/needsYouSignals";
import { pendingCard, setPendingCard } from "../../utils/pendingCard";
import { NAVIGATE, onWith, type NavTarget } from "../../utils/events";
import type { ReviewItem } from "../../utils/reviewSignals";

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
    secondOpinion: null,
  };
}

function event(id: string, project: string, ts: number, extra: Partial<NeedsYouEvent> = {}): NeedsYouEvent {
  return {
    id,
    ts,
    session: `s-${id}`,
    folder: `/work/${project}`,
    branch: null,
    project,
    title: `chat ${id}`,
    kind: "permission",
    resolvedAt: null,
    settled: false,
    chat: true,
    ...extra,
  };
}

let listed: ReviewItem[] = [];
let events: NeedsYouEvent[] = [];

beforeEach(async () => {
  listed = [item("calm", 12), item("risky", 64), item("busy", 30, true)];
  events = [];
  setPendingCard(null);
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "needs_you_list") return events;
    if (cmd === "review_inbox") return listed;
    if (cmd === "review_mark") {
      const id = (args as { unit: { id: string } }).unit.id;
      listed = listed.filter((i) => i.unit.id !== id);
    }
    return undefined;
  });
  await refreshNeedsYou();
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

  it("opens on Needs you, grouped by project with the newest group first and answered rows dimmed", async () => {
    events = [
      event("old", "api", 100, { resolvedAt: 150 }),
      event("mid", "web", 200, { kind: "done" }),
      event("new", "api", 300, { kind: "question" }),
    ];
    await Promise.all([refreshInbox(), refreshNeedsYou()]);
    const { container } = render(() => <InboxView />);
    expect(screen.getByRole("button", { name: "Needs you 2" }).getAttribute("aria-pressed")).toBe("true");
    const groups = [...container.querySelectorAll("section section")];
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["api", "web"]);
    const titles = [...groups[0].querySelectorAll("li")].map((li) => li.textContent);
    expect(titles[0]).toContain("chat new");
    expect(titles[1]).toContain("chat old");
    expect(titles[1]).toContain("answered");
    expect(screen.getByText("chat old").closest("li")!.className).toMatch(/answered/);
    expect(screen.getByText("chat new").closest("li")!.className).not.toMatch(/answered/);
    await expectNoAxeViolations(container);
  });

  it("opens on Review when nothing needs you and there is work to review", async () => {
    events = [event("old", "api", 100, { resolvedAt: 150 })];
    await Promise.all([refreshInbox(), refreshNeedsYou()]);
    render(() => <InboxView />);
    expect(screen.getByRole("button", { name: "Review 3" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("task risky")).toBeTruthy();
  });

  it("an open block navigates to its session at the card and marks it seen", async () => {
    events = [event("q", "api", 300, { kind: "question" })];
    await refreshNeedsYou();
    const targets: NavTarget[] = [];
    const off = onWith<NavTarget>(NAVIGATE, (t) => targets.push(t));
    render(() => <InboxView />);
    fireEvent.click(screen.getByText("chat q"));
    off();
    expect(targets).toEqual([{ folder: "/work/api", session: "s-q" }]);
    expect(pendingCard()).toBe("s-q");
    expect(invoke).toHaveBeenCalledWith("needs_you_seen", { session: "s-q", folder: "/work/api", branch: null });
  });

  it("a pull request row navigates to its folder and asks for no card", async () => {
    events = [event("pr", "api", 300, { kind: "pullRequest", session: null, branch: "fix", title: "fix" })];
    await refreshNeedsYou();
    const targets: NavTarget[] = [];
    const off = onWith<NavTarget>(NAVIGATE, (t) => targets.push(t));
    render(() => <InboxView />);
    fireEvent.click(screen.getByText("fix"));
    off();
    expect(targets).toEqual([{ folder: "/work/api" }]);
    expect(pendingCard()).toBeNull();
  });
});
