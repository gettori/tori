// The card the strip is short for, and the two states it lives in.
//
// The rule under test is opens on hover, stays on click. Nothing on the card
// writes a setting (the quota controls are on the account's settings card), so
// the two states differ only in what closes it.
//
// The other half is the gap. The popover is portalled and gutter-offset, so a
// pointer travelling from a bar to the card is briefly over neither surface; a
// card that closed on `mouseleave` could never be reached at all.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

type Profile = {
  id: string;
  label: string;
  signIn: string;
  account: string | null;
  apiKeySource: string | null;
};

const ONE_LOGIN: Profile[] = [
  { id: "default", label: "Default", signIn: "signedIn", account: "me@example.com", apiKeySource: null },
];

const bench = vi.hoisted(() => ({
  enabled: new Set<string>(["claude"]),
  usage: {} as Record<string, { accounts?: Record<string, { windows?: string[] }> }>,
  saved: [] as unknown[],
  polled: [] as [string, string, string | null][],
  profiles: [] as {
    id: string;
    label: string;
    signIn: string;
    account: string | null;
    apiKeySource: string | null;
  }[],
}));

vi.mock("../../panels/Settings/settingsStore", () => ({
  get settings() {
    return { budgets: { warnAtFraction: 0.8 }, agent: { usage: bench.usage } };
  },
  saveSettings: async (next: unknown) => {
    bench.saved.push(next);
  },
}));

vi.mock("../../utils/agentEnabled", () => ({ agentEnabled: (id: string) => bench.enabled.has(id) }));

// The probe is a process spawn. Its schedule is its own test; here it is a
// record of what the card asked for.
vi.mock("../../utils/usageProbe", async (orig) => ({
  ...(await orig<typeof import("../../utils/usageProbe")>()),
  pollUsage: (agentId: string, trigger: string, profile: string | null = null) => {
    bench.polled.push([agentId, trigger, profile]);
  },
}));

const adapters = [
  { id: "claude", label: "Claude", icon: "claude", usage: { sources: ["sessions"] }, usage_reason: null },
  { id: "codex", label: "Codex", icon: "codex", usage: { sources: ["cli"] }, usage_reason: null },
];
vi.mock("../../utils/agents", async (orig) => {
  const actual = await orig<typeof import("../../utils/agents")>();
  return { ...actual, agents: () => adapters, findAdapter: (id: string) => adapters.find((a) => a.id === id) ?? { id, label: id } };
});

vi.mock("../../utils/agentHealth", async (orig) => ({
  ...(await orig<typeof import("../../utils/agentHealth")>()),
  // Named only where naming says something, which is what the real one does:
  // "Default" is a word for the only thing there is.
  profileLabel: (_id: string, profile: string | null) =>
    bench.profiles.length > 1
      ? (bench.profiles.find((p) => p.id === (profile ?? "default"))?.label ?? null)
      : null,
  // Claude is the one bundled agent whose `whoami` names an account. Codex's
  // answers in an exit code, so it reaches the card only through its probe.
  namedProfiles: (id: string) => (id === "claude" ? bench.profiles : []),
}));

const { default: UsageStrip } = await import("./UsageStrip");
const { resetUsageStoreForTests, seedUsageStoreForTests } = await import("../../utils/usageStore");
const { resetUsageProbeForTests, seedUsageIdentityForTests } = await import("../../utils/usageProbe");

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
const LATER = Math.floor(NOW / 1000) + 3 * 60 * 60;

/** Kobalte installs its outside listener from a `setTimeout(0)`, so a dismissal
 *  test has to let one macrotask through first. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  bench.enabled = new Set(["claude"]);
  bench.usage = {};
  bench.saved = [];
  bench.polled = [];
  bench.profiles = [...ONE_LOGIN];
  resetUsageStoreForTests();
  resetUsageProbeForTests();
  seedUsageStoreForTests(
    "claude",
    null,
    [
      { kind: "five_hour", utilization: 0.42, resetsAt: LATER, status: null, reachedType: null },
      { kind: "seven_day", utilization: 0.11, resetsAt: LATER, status: null, reachedType: null },
    ],
    NOW,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

const cluster = () => screen.getByRole("button", { name: /^Claude usage/ });
const card = () => screen.queryByRole("dialog", { name: /usage detail/ });

/** Hover the strip and let the open delay elapse. */
async function hoverOpen() {
  fireEvent.mouseEnter(cluster());
  await vi.advanceTimersByTimeAsync(400);
}

describe("opening on hover", () => {
  it("waits for the delay, then opens read-only", async () => {
    render(() => <UsageStrip />);

    fireEvent.mouseEnter(cluster());
    // A pointer crossing the strip on its way elsewhere opens nothing.
    await vi.advanceTimersByTimeAsync(100);
    expect(card()).toBeNull();

    await vi.advanceTimersByTimeAsync(300);
    expect(card()).toBeTruthy();
  });

  it("shows the account, every window, and how old the numbers are", async () => {
    render(() => <UsageStrip />);
    await hoverOpen();

    const text = card()!.textContent!;
    expect(text).toContain("me@example.com");
    expect(text).toContain("5h rolling");
    expect(text).toContain("42.0%");
    expect(text).toContain("all models");
    expect(text).toContain("11.0%");
    // Freshness once for the card, rather than a source and a timestamp per row.
    expect(text).toContain("0s ago");
  });
});

// The chips decide what the titlebar carries, and only that. The card is the
// whole picture, so a window switched off the strip is still on it.
describe("a window switched off the strip", () => {
  it("stays on the card", async () => {
    bench.usage = { claude: { accounts: { default: { windows: ["five_hour"] } } } };
    render(() => <UsageStrip />);

    const row = cluster();
    expect(row.querySelectorAll("[data-kind]")).toHaveLength(1);

    await hoverOpen();
    const text = card()!.textContent!;
    expect(text).toContain("5h rolling");
    expect(text).toContain("all models");
    expect(text).toContain("11.0%");
  });
});

describe("the gap between the strip and the card", () => {
  it("stays open while the pointer moves from one to the other", async () => {
    render(() => <UsageStrip />);
    await hoverOpen();

    fireEvent.mouseLeave(cluster());
    // Mid-flight: off the strip, not yet on the card, and the grace has not run.
    await vi.advanceTimersByTimeAsync(100);
    fireEvent.mouseEnter(card()!.firstElementChild!);
    await vi.advanceTimersByTimeAsync(500);

    expect(card()).toBeTruthy();
  });

  it("closes once the pointer has left both and the grace has run", async () => {
    render(() => <UsageStrip />);
    await hoverOpen();

    fireEvent.mouseEnter(card()!.firstElementChild!);
    fireEvent.mouseLeave(card()!.firstElementChild!);
    await vi.advanceTimersByTimeAsync(100);
    expect(card()).toBeTruthy();

    await vi.advanceTimersByTimeAsync(300);
    await waitFor(() => expect(card()).toBeNull());
  });
});

describe("pinning it with a click", () => {
  it("keeps it open after the pointer leaves", async () => {
    render(() => <UsageStrip />);

    fireEvent.click(cluster());
    expect(card()).toBeTruthy();

    fireEvent.mouseLeave(cluster());
    await vi.advanceTimersByTimeAsync(1000);
    expect(card()).toBeTruthy();
  });

  // The settings card owns the quota controls. Pinned so a switch cannot drift
  // back onto a surface that opens under a passing pointer.
  it("carries no control that writes a setting", () => {
    render(() => <UsageStrip />);

    fireEvent.click(cluster());
    expect(screen.queryByRole("switch")).toBeNull();
    expect(bench.saved).toHaveLength(0);
  });

  // The strip rebuilds its rows from scratch on every reading, and `For` is
  // keyed by reference, so it used to replace the very button the card is
  // anchored to on each turn boundary. `Index` keys by position instead.
  it("survives a reading landing while it is pinned", async () => {
    render(() => <UsageStrip />);

    fireEvent.click(cluster());
    const anchored = cluster();
    expect(card()).toBeTruthy();

    seedUsageStoreForTests(
      "claude",
      null,
      [{ kind: "five_hour", utilization: 0.44, resetsAt: LATER, status: null, reachedType: null }],
      NOW,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(card()).toBeTruthy();
    // The same element, not a replacement wearing the same label: a popover
    // anchored to a removed node has nowhere to sit.
    expect(cluster()).toBe(anchored);
  });

  it("closes on Escape", async () => {
    render(() => <UsageStrip />);

    fireEvent.click(cluster());
    await settle();
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(card()).toBeNull());
  });

  it("closes on a press outside, which the anchor's own press is not", async () => {
    render(() => <UsageStrip />);

    fireEvent.click(cluster());
    await settle();

    fireEvent.pointerDown(cluster());
    fireEvent.mouseDown(cluster());
    expect(card()).toBeTruthy();

    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(card()).toBeNull());
  });
});

// Codex answers `login status` with an exit code and no name, so the probe's
// own `account/read` is the only place an email or a plan for it exists.
describe("an account only the probe can name", () => {
  const codexCard = () => screen.queryByRole("dialog", { name: /Codex usage detail/ });

  function withCodex(identity: Parameters<typeof seedUsageIdentityForTests>[2]) {
    bench.enabled = new Set(["codex"]);
    seedUsageStoreForTests(
      "codex",
      null,
      [{ kind: "five_hour", utilization: 0.03, resetsAt: LATER, status: null, reachedType: null, source: "cli" }],
      NOW,
    );
    seedUsageIdentityForTests("codex", null, identity);
    render(() => <UsageStrip />);
    fireEvent.click(screen.getByRole("button", { name: /^Codex usage/ }));
  }

  it("renders the email and the plan the probe read", () => {
    withCodex({ email: "codex-user@example.com", planType: "plus" });

    const text = codexCard()!.textContent!;
    expect(text).toContain("codex-user@example.com");
    // Reshaped, not passed through: `plus` is a wire token.
    expect(text).toContain("Plus");
  });

  it("shows a balance there is something to spend, and stays quiet otherwise", () => {
    withCodex({ planType: "plus", credits: { hasCredits: true, unlimited: false, balance: "42" } });
    expect(codexCard()!.textContent).toContain("42 credits");
  });

  // Every account without credits reports the same "0", which is not news.
  it("says nothing about a zero balance", () => {
    withCodex({ planType: "plus", credits: { hasCredits: false, unlimited: false, balance: "0" } });
    expect(codexCard()!.textContent).not.toContain("credits");
  });
});

// Two logins on one agent, which is the case the whole per-account shape exists
// for: one card, an account row that switches it, and a sentence that names the
// login in trouble even when it is not the one on screen.
describe("two logins on one agent", () => {
  const NEAR = 0.881;

  function withTwo() {
    bench.profiles = [
      { id: "default", label: "Personal", signIn: "signedIn", account: "me@example.com", apiKeySource: null },
      { id: "fonn", label: "Fonn", signIn: "signedIn", account: "arif@fonngroup.com", apiKeySource: null },
    ];
    seedUsageStoreForTests(
      "claude",
      "fonn",
      [{ kind: "seven_day", utilization: NEAR, resetsAt: LATER, status: null, reachedType: null }],
      NOW,
    );
    render(() => <UsageStrip />);
    fireEvent.click(screen.getByRole("button", { name: /^Personal usage/ }));
  }

  it("puts both accounts in the card and switches the windows with them", () => {
    withTwo();

    const open = screen.getByRole("dialog", { name: /usage detail/ });
    expect(open.textContent).toContain("42.0%");

    fireEvent.click(screen.getByRole("button", { name: "Fonn" }));
    // The other login's own window, not the one the strip was hovered on.
    expect(open.textContent).toContain("88.1%");
    expect(open.textContent).not.toContain("42.0%");
  });

  // The case a glance at the strip misses: the row you are signed into is fine
  // and the one beside it is nearly out.
  it("names the other login in the pace line when it is the one in trouble", () => {
    withTwo();

    const text = screen.getByRole("dialog", { name: /usage detail/ }).textContent!;
    expect(text).toContain("Fonn is the one to watch");
    expect(text).toContain("88.1%");
  });
});

describe("reading again", () => {
  // Codex has a CLI read, so the card can ask. Claude on the sessions rung
  // cannot: its numbers ride on chat turns, and a button there would spawn
  // nothing and say it had.
  it("offers a refresh only where there is a read to run", async () => {
    render(() => <UsageStrip />);
    await hoverOpen();
    expect(screen.queryByRole("button", { name: "Read again" })).toBeNull();
  });

  it("asks the probe straight away on a press", () => {
    bench.enabled = new Set(["codex"]);
    seedUsageStoreForTests(
      "codex",
      null,
      [{ kind: "five_hour", utilization: 0.03, resetsAt: LATER, status: null, reachedType: null, source: "cli" }],
      NOW,
    );
    render(() => <UsageStrip />);
    fireEvent.click(screen.getByRole("button", { name: /^Codex usage/ }));

    fireEvent.click(screen.getByRole("button", { name: "Read again" }));
    expect(bench.polled).toEqual([["codex", "manual", null]]);
  });
});

describe("what the card does not offer", () => {
  // A 7-day view was built and taken out again (Phase 5): the ring records what
  // Sway read, the window belongs to the account, and a stretch with Sway shut
  // has no samples in it while the level goes on moving. Pinned so the link
  // cannot drift back in without the argument being had again.
  it("has no breakdown link, because there is no history worth linking to", async () => {
    render(() => <UsageStrip />);
    await hoverOpen();

    expect(screen.queryByRole("button", { name: /Breakdown/ })).toBeNull();
  });
});
