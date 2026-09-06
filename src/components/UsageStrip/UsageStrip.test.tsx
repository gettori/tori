// What the titlebar says about each account's quota.
//
// The distinction under test is temporal, not visual: a reading past its reset
// is a *wrong* number, so it renders as the word "reset" with no percentage,
// while a merely old one keeps its number and goes dim. Drawing 98% on a quota
// that has since emptied is the failure the three states exist to prevent.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";

const bench = vi.hoisted(() => ({
  enabled: new Set<string>(),
  usage: {} as Record<string, { source?: string; detail?: string; hiddenProfiles?: string[] }>,
  warnAt: 0.8,
}));

vi.mock("../../panels/Settings/settingsStore", () => ({
  get settings() {
    return { budgets: { warnAtFraction: bench.warnAt }, agent: { usage: bench.usage } };
  },
  saveSettings: async () => {},
}));

vi.mock("../../utils/agentEnabled", () => ({
  agentEnabled: (id: string) => bench.enabled.has(id),
}));

// The window-drag carve-out is asserted here rather than in `windowDrag.test.tsx`
// on purpose: that file presses hand-written chrome, and what has to keep
// holding is that the strip *this component renders* is skipped, not that a
// `<button>` in general is.
const dragged = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    startDragging: () => (dragged(), Promise.resolve()),
    toggleMaximize: () => Promise.resolve(),
  }),
}));

const adapters = [
  { id: "claude", label: "Claude", icon: "claude", usage: { sources: ["sessions", "token"] }, usage_reason: null },
  { id: "codex", label: "Codex", icon: "codex", usage: { sources: ["sessions"] }, usage_reason: null },
];
vi.mock("../../utils/agents", async (orig) => {
  const actual = await orig<typeof import("../../utils/agents")>();
  return {
    ...actual,
    agents: () => adapters,
    findAdapter: (id: string) => adapters.find((a) => a.id === id) ?? { id, label: id },
  };
});

vi.mock("../../utils/agentHealth", async (orig) => ({
  ...(await orig<typeof import("../../utils/agentHealth")>()),
  // Two Claude logins, so the default row and a named one can be told apart.
  profileLabel: (_id: string, profile: string | null) => (profile === "work" ? "Work" : null),
}));

const { default: UsageStrip, shouldCollapse, tightestWindow } = await import("./UsageStrip");
const { resetUsageStoreForTests, seedUsageStoreForTests } = await import("../../utils/usageStore");
const { default: styles } = await import("./UsageStrip.module.css");
const { windowDragStart } = await import("../../utils/windowDrag");

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
/** Far enough out that nothing under test expires by accident. */
const LATER = Math.floor(NOW / 1000) + 3 * 60 * 60;
const PASSED = Math.floor(NOW / 1000) - 60;

const win = (kind: string, utilization: number | null, resetsAt: number | null = LATER) => ({
  kind,
  utilization,
  resetsAt,
  status: null,
  reachedType: null,
});

beforeEach(() => {
  vi.setSystemTime(NOW);
  bench.enabled = new Set(["claude", "codex"]);
  bench.usage = {};
  bench.warnAt = 0.8;
  dragged.mockClear();
  resetUsageStoreForTests();
});

const clusterFor = (agentId: string, profile: string) =>
  document.querySelector<HTMLElement>(`[data-agent="${agentId}"][data-profile="${profile}"]`);
const barsIn = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>("[data-kind]")];

// The model-scoped weekly window is the whole reason the account-token rung
// exists: no passive frame carries it. It is also the one window a reader has
// not asked for unless they said Full, so the detail level is what gates it.
describe("the model-scoped window", () => {
  const seedScoped = () =>
    seedUsageStoreForTests(
      "claude",
      null,
      [
        { ...win("five_hour", 0.07), source: "token" as const },
        { ...win("seven_day", 0.28), source: "token" as const },
        { ...win("seven_day_fable", 0.26), source: "token" as const },
      ],
      NOW,
    );

  it("is drawn at Full, and named after the model rather than the wire key", () => {
    bench.usage = { claude: { detail: "full" } };
    seedScoped();
    render(() => <UsageStrip />);

    const row = clusterFor("claude", "default")!;
    expect(barsIn(row).map((b) => b.dataset.kind)).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_fable",
    ]);
    expect(row.getAttribute("aria-label")).toContain("7-day (Fable)");
    expect(row.getAttribute("aria-label")).not.toContain("seven_day_fable");
  });

  it("is hidden at Standard, which still draws both generic windows", () => {
    bench.usage = { claude: { detail: "standard" } };
    seedScoped();
    render(() => <UsageStrip />);

    const row = clusterFor("claude", "default")!;
    expect(barsIn(row).map((b) => b.dataset.kind)).toEqual(["five_hour", "seven_day"]);
    expect(row.getAttribute("aria-label")).not.toContain("Fable");
  });
});

describe("the full row", () => {
  it("draws every generic window of the account you are signed into", () => {
    seedUsageStoreForTests("claude", null, [win("five_hour", 0.42), win("seven_day", 0.11)], NOW);
    render(() => <UsageStrip />);

    const row = clusterFor("claude", "default")!;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("Claude");
    expect(barsIn(row).map((b) => b.dataset.kind)).toEqual(["five_hour", "seven_day"]);
    expect(row.textContent).toContain("42%");
    expect(row.textContent).toContain("11%");
  });

  // Absence is a property of the source, never a level of zero: a window no
  // source has ever returned has nothing true to draw.
  it("renders no bar for a window nothing has reported", () => {
    seedUsageStoreForTests("claude", null, [win("five_hour", 0.42)], NOW);
    render(() => <UsageStrip />);

    const row = clusterFor("claude", "default")!;
    expect(barsIn(row)).toHaveLength(1);
    expect(row.textContent).not.toContain("7-day");
  });

  it("wears the attention role approaching and the danger role reached", () => {
    seedUsageStoreForTests("claude", null, [win("five_hour", 0.85), win("seven_day", 1)], NOW);
    render(() => <UsageStrip />);

    const [five, seven] = barsIn(clusterFor("claude", "default")!);
    expect(five.className).toContain(styles.approaching);
    expect(five.className).not.toContain(styles.reached);
    expect(seven.className).toContain(styles.reached);
  });
});

describe("a second account on the same agent", () => {
  it("is compact: its own label and only the window it is nearest to", () => {
    seedUsageStoreForTests("claude", null, [win("five_hour", 0.1), win("seven_day", 0.1)], NOW);
    seedUsageStoreForTests("claude", "work", [win("five_hour", 0.2), win("seven_day", 0.9)], NOW);
    render(() => <UsageStrip />);

    const row = clusterFor("claude", "work")!;
    expect(row.textContent).toContain("Work");
    expect(barsIn(row).map((b) => b.dataset.kind)).toEqual(["seven_day"]);
    // And the default row keeps both, which is the contrast being asserted.
    expect(barsIn(clusterFor("claude", "default")!)).toHaveLength(2);
  });

  it("is left off the strip when the user hid it, and the default never can be", () => {
    bench.usage = { claude: { hiddenProfiles: ["work", "default"] } };
    seedUsageStoreForTests("claude", null, [win("five_hour", 0.1)], NOW);
    seedUsageStoreForTests("claude", "work", [win("five_hour", 0.2)], NOW);
    render(() => <UsageStrip />);

    expect(clusterFor("claude", "work")).toBeNull();
    expect(clusterFor("claude", "default")).toBeTruthy();
  });
});

describe("how old the number is", () => {
  it("dims a reading nothing has refreshed lately and says when it was read", () => {
    const stale = { ...win("five_hour", 0.42), sampledAt: NOW - 30 * 60_000 };
    seedUsageStoreForTests("claude", null, [stale], NOW);
    render(() => <UsageStrip />);

    const row = clusterFor("claude", "default")!;
    const [bar] = barsIn(row);
    expect(bar.className).toContain(styles.stale);
    // The age reaches a keyboard user, not just a pointer resting on the bar.
    expect(row.getAttribute("aria-label")).toContain("last read 30 min ago");
    // Old, not wrong: the number it last had is still what it last had.
    expect(bar.textContent).toContain("42%");
  });

  // The one case a dimmed number would be a lie. Both windows are gone, and the
  // account still has a cluster: it has readings, they just say "reset".
  it("says reset with no percentage once a window is past its reset", () => {
    seedUsageStoreForTests(
      "claude",
      null,
      [win("five_hour", 0.98, PASSED), win("seven_day", 0.75, PASSED)],
      NOW,
    );
    render(() => <UsageStrip />);

    const row = clusterFor("claude", "default")!;
    const bars = barsIn(row);
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(bar.className).toContain(styles.expired);
      expect(bar.textContent).toContain("reset");
    }
    expect(row.textContent).not.toContain("98%");
    expect(row.textContent).not.toContain("75%");
  });
});

describe("which accounts reach the strip at all", () => {
  it("renders nothing when no account has a reading", () => {
    render(() => <UsageStrip />);
    expect(screen.queryByLabelText("Agent usage")).toBeNull();
  });

  it("skips an agent the user turned off and one whose source is off", () => {
    bench.enabled = new Set(["claude"]);
    bench.usage = { claude: { source: "off" } };
    seedUsageStoreForTests("claude", null, [win("five_hour", 0.42)], NOW);
    seedUsageStoreForTests("codex", null, [win("five_hour", 0.42)], NOW);
    render(() => <UsageStrip />);

    expect(screen.queryByLabelText("Agent usage")).toBeNull();
  });

  // A press has to land on something the window-drag carve-out skips, or
  // glancing at your quota would drag the whole window instead. Pressed on the
  // bar, not on the cluster, since that is the pixel a reader actually aims at.
  it("takes a press without dragging the window", () => {
    seedUsageStoreForTests("claude", null, [win("five_hour", 0.42)], NOW);
    render(() => <UsageStrip />);

    const bar = barsIn(screen.getByRole("button", { name: /^Claude usage/ }))[0];
    const e = new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1 });
    Object.defineProperty(e, "target", { value: bar });
    windowDragStart(e);

    expect(dragged).not.toHaveBeenCalled();
  });
});

describe("the collapse threshold", () => {
  it("is about the topbar's width, since the strip's own is its content's", () => {
    expect(shouldCollapse(1400)).toBe(false);
    expect(shouldCollapse(700)).toBe(true);
    // Nothing has measured yet, which is not the same as being narrow.
    expect(shouldCollapse(0)).toBe(false);
  });
});

describe("the one window a compact row shows", () => {
  it("is the one with the least headroom, not the first one reported", () => {
    const windows = [
      { ...win("five_hour", 0.2), sampledAt: NOW, source: "sessions" as const },
      { ...win("seven_day", 0.91), sampledAt: NOW, source: "sessions" as const },
    ];
    expect(tightestWindow(windows)?.kind).toBe("seven_day");
  });

  // A reset window has no headroom problem at all, so it never wins over one
  // that does, however high the number it last held was.
  it("never picks a window that has already reset over a live one", () => {
    const windows = [
      { ...win("five_hour", 0.99, PASSED), sampledAt: NOW, source: "sessions" as const },
      { ...win("seven_day", 0.05), sampledAt: NOW, source: "sessions" as const },
    ];
    expect(tightestWindow(windows)?.kind).toBe("seven_day");
  });
});
