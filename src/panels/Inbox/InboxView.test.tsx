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
import { refreshDigest, type Digest, type Finished } from "../../utils/digest";

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

function finished(session: string, extra: Partial<Finished> = {}): Finished {
  return {
    session,
    folder: `/work/app/${session}`,
    branch: null,
    project: "app",
    title: `run ${session}`,
    chat: true,
    turns: 2,
    firstTs: 1_000,
    lastTs: 2_000,
    lines: { added: 120, removed: 30 },
    verdict: "verified",
    ...extra,
  };
}

let listed: ReviewItem[] = [];
let events: NeedsYouEvent[] = [];
let since: Digest | null = null;

beforeEach(async () => {
  listed = [item("calm", 12), item("risky", 64), item("busy", 30, true)];
  events = [];
  since = null;
  setPendingCard(null);
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "needs_you_list") return events;
    if (cmd === "digest_list") return since;
    if (cmd === "review_inbox") return listed;
    if (cmd === "review_mark") {
      const id = (args as { unit: { id: string } }).unit.id;
      listed = listed.filter((i) => i.unit.id !== id);
    }
    return undefined;
  });
  await refreshNeedsYou();
  await refreshDigest();
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
    expect(mark?.getAttribute("aria-label")).toBe("Mark reviewed");
  });

  it("opens on Needs you, grouped by project with the newest group first and answered rows dimmed", async () => {
    events = [
      event("old", "api", 100, { resolvedAt: 150 }),
      event("mid", "web", 200, { kind: "done" }),
      event("new", "api", 300, { kind: "question" }),
    ];
    await Promise.all([refreshInbox(), refreshNeedsYou()]);
    const { container } = render(() => <InboxView />);
    expect(screen.getByRole("button", { name: "Needs you 2" }).getAttribute("aria-current")).toBe("page");
    const groups = [...container.querySelectorAll("section")];
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
    expect(screen.getByRole("button", { name: "Review 3" }).getAttribute("aria-current")).toBe("page");
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

  it("opens on Since you looked with each finished session's lines and verdict, and a row opens it", async () => {
    since = {
      since: 500,
      asOf: 3_000,
      ready: true,
      finished: [finished("a"), finished("b", { chat: false, turns: 1, lines: null, verdict: null })],
      waiting: [event("q", "api", 300, { kind: "question" })],
      happened: [],
    };
    await refreshDigest();
    const targets: NavTarget[] = [];
    const off = onWith<NavTarget>(NAVIGATE, (t) => targets.push(t));
    const { container } = render(() => <InboxView />);
    expect(screen.getByRole("button", { name: "Since you looked 3" }).getAttribute("aria-current")).toBe("page");
    const a = screen.getByText("run a").closest("li")!.textContent!;
    expect(a).toContain("2 turns");
    expect(a).toContain("+120 -30");
    expect(a).toContain("Verified");
    const b = screen.getByText("run b").closest("li")!.textContent!;
    expect(b).toContain("1 turn");
    expect(b).not.toContain("Verified");
    expect(screen.getByText("chat q")).toBeTruthy();
    await expectNoAxeViolations(container);
    fireEvent.click(screen.getByText("run a"));
    off();
    expect(targets).toEqual([{ folder: "/work/app/a", session: "a" }]);
  });

  it("marks the digest seen at the time it read, once it stops showing", async () => {
    since = { since: 500, asOf: 3_000, ready: true, finished: [finished("a")], waiting: [], happened: [] };
    await refreshDigest();
    const { unmount } = render(() => <InboxView />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("digest_list", { since: undefined }));
    expect(invoke).not.toHaveBeenCalledWith("digest_looked", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: /^Needs you/ }));
    expect(invoke).toHaveBeenCalledWith("digest_looked", { at: 3_000 });
    unmount();
  });

  it("lists pull requests and limits since you looked, a pull request opening its worktree and a limit its chat", async () => {
    since = {
      since: 500,
      asOf: 3_000,
      ready: true,
      finished: [],
      waiting: [],
      happened: [
        event("m", "api", 2_000, {
          kind: "prMerged",
          session: null,
          branch: "fix",
          title: "#7 Fix it",
          resolvedAt: 2_000,
        }),
        event("l", "", 1_000, { kind: "limitHit", title: "claude work", resolvedAt: 1_000 }),
      ],
    };
    await refreshDigest();
    const targets: NavTarget[] = [];
    const off = onWith<NavTarget>(NAVIGATE, (t) => targets.push(t));
    const { container } = render(() => <InboxView />);
    expect(screen.getByRole("region", { name: "Pull requests" }).textContent).toContain("Pull request merged");
    expect(screen.getByRole("region", { name: "Usage limits" }).textContent).toContain("Hit its usage limit");
    await expectNoAxeViolations(container);
    fireEvent.click(screen.getByText("#7 Fix it"));
    fireEvent.click(screen.getByText("claude work"));
    off();
    expect(targets).toEqual([{ folder: "/work/api" }, { folder: "/work/", session: "s-l" }]);
  });
});
