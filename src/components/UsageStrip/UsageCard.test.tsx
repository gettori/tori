// The card the strip is short for, and the two states it lives in.
//
// The rule under test is read-only on hover, interactive on pinned. A card that
// arrives under the pointer with live controls on it is a card you change by
// accident on the way somewhere else, so hovering explains and clicking commits.
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

const bench = vi.hoisted(() => ({
  enabled: new Set<string>(["claude"]),
  usage: {} as Record<string, { source?: string; notify?: boolean }>,
  saved: [] as unknown[],
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
  profileLabel: () => null,
  // Claude is the one bundled agent whose `whoami` names an account. Codex's
  // answers in an exit code, so it reaches the card only through its probe.
  namedProfiles: (id: string) =>
    id === "claude"
      ? [{ id: "default", label: "Default", signIn: "signedIn", account: "me@example.com", apiKeySource: null }]
      : [],
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
    expect(screen.getByRole("switch", { name: /Notify/ }).getAttribute("aria-disabled")).toBe("true");
  });

  it("shows the account, every window, and where each number came from", async () => {
    render(() => <UsageStrip />);
    await hoverOpen();

    const text = card()!.textContent!;
    expect(text).toContain("me@example.com");
    expect(text).toContain("5-hour");
    expect(text).toContain("42%");
    expect(text).toContain("7-day");
    expect(text).toContain("11%");
    expect(text).toContain("sessions");
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
  it("keeps it open after the pointer leaves, and enables the controls", async () => {
    render(() => <UsageStrip />);

    fireEvent.click(cluster());
    expect(card()).toBeTruthy();

    const toggle = screen.getByRole("switch", { name: /Notify/ });
    expect(toggle.getAttribute("aria-disabled")).not.toBe("true");

    fireEvent.mouseLeave(cluster());
    await vi.advanceTimersByTimeAsync(1000);
    expect(card()).toBeTruthy();
  });

  it("writes the notify answer only once pinned", async () => {
    render(() => <UsageStrip />);

    await hoverOpen();
    fireEvent.click(screen.getByRole("switch", { name: /Notify/ }));
    expect(bench.saved).toHaveLength(0);

    fireEvent.click(cluster());
    fireEvent.click(screen.getByRole("switch", { name: /Notify/ }));
    await waitFor(() => expect(bench.saved).toHaveLength(1));
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
    expect(text).toContain("cli");
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

describe("the breakdown link", () => {
  it("is present and refusing until the 7-day view exists", async () => {
    render(() => <UsageStrip />);
    await hoverOpen();

    expect(screen.getByRole("button", { name: /Breakdown/ })).toHaveProperty("disabled", true);
  });
});
