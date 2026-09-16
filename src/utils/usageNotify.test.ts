// When a quota crossing is worth the OS's attention.
//
// Two rules, and they pull in opposite directions on purpose. **Nothing while
// the window is focused**, because a focused Tori is already showing the strip.
// And **once per window per reset, across restarts**, because the record of
// what has been said is on disk and a notice repeated on every launch is the
// failure that record exists to prevent.
import { describe, it, expect, vi, beforeEach } from "vitest";

const bench = vi.hoisted(() => ({
  focused: false,
  enabled: new Set<string>(["claude"]),
  usage: {} as Record<
    string,
    { accounts?: Record<string, { windows?: string[]; warnAt?: number; notify?: boolean }> }
  >,
  /** What the backend would hand back on the next load. */
  stored: null as unknown,
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
  sendNotification: () => {},
  onAction: async () => () => {},
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "usage_snapshot_save") bench.stored = args.snapshot;
    if (cmd === "usage_snapshot_load") return bench.stored;
    return null;
  },
}));

vi.mock("../panels/Settings/settingsStore", () => ({
  get settings() {
    return { budgets: { warnAtFraction: 0.8 }, agent: { usage: bench.usage } };
  },
  saveSettings: async () => {},
}));

vi.mock("./agentEnabled", () => ({ agentEnabled: (id: string) => bench.enabled.has(id) }));

const adapters = [{ id: "claude", label: "Claude", usage: { sources: ["sessions"] }, usage_reason: null }];
vi.mock("./agents", async (orig) => {
  const actual = await orig<typeof import("./agents")>();
  return { ...actual, agents: () => adapters, findAdapter: (id: string) => adapters.find((a) => a.id === id) ?? { id, label: id } };
});

vi.mock("./agentHealth", async (orig) => ({
  ...(await orig<typeof import("./agentHealth")>()),
  profileLabel: (_id: string, profile: string | null) => (profile === "work" ? "Work" : null),
}));

const { collectQuotaNotifications } = await import("./usageNotify");
const { loadUsageStore, resetUsageStoreForTests, saveUsageStore, seedUsageStoreForTests } =
  await import("./usageStore");

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
const LATER = Math.floor(NOW / 1000) + 3 * 60 * 60;

const win = (utilization: number, kind = "five_hour", resetsAt = LATER) => ({
  kind,
  utilization,
  resetsAt,
  status: null,
  reachedType: null,
});

beforeEach(() => {
  bench.focused = false;
  bench.enabled = new Set(["claude"]);
  bench.usage = {};
  bench.stored = null;
  resetUsageStoreForTests();
});

describe("what earns a notification", () => {
  it("says nothing at ok", () => {
    seedUsageStoreForTests("claude", null, [win(0.4)], NOW);
    expect(collectQuotaNotifications(NOW, bench.focused)).toEqual([]);
  });

  it("names the account and says what the window says", () => {
    seedUsageStoreForTests("claude", null, [win(0.85)], NOW);
    const [n] = collectQuotaNotifications(NOW, bench.focused);
    expect(n.title).toBe("Claude");
    expect(n.body).toContain("You have used 85% of your rolling 5-hour limit");
  });

  it("uses the account's own name when it has one", () => {
    seedUsageStoreForTests("claude", "work", [win(1)], NOW);
    expect(collectQuotaNotifications(NOW, bench.focused)[0].title).toBe("Work");
  });

  it("fires for approaching and reached, and for each window separately", () => {
    seedUsageStoreForTests("claude", null, [win(0.85), win(1, "seven_day")], NOW);
    const sent = collectQuotaNotifications(NOW, bench.focused);
    expect(sent).toHaveLength(2);
    expect(sent.map((n) => n.body).join(" ")).toContain("has been reached");
  });
});

describe("the focus rule", () => {
  // A focused Tori is already showing the strip, and a chat on that account is
  // showing the banner. A notification would be a second copy of what is on
  // screen.
  it("sends nothing while the window has focus", () => {
    bench.focused = true;
    seedUsageStoreForTests("claude", null, [win(1)], NOW);
    expect(collectQuotaNotifications(NOW, bench.focused)).toEqual([]);
  });

  // The other half, and the one that is easy to get wrong: the crossing was
  // delivered, by the strip. Firing it again on the next tab-away would be news
  // about something already seen.
  it("counts a crossing seen while focused as said, so tabbing away does not repeat it", () => {
    seedUsageStoreForTests("claude", null, [win(1)], NOW);
    bench.focused = true;
    expect(collectQuotaNotifications(NOW, bench.focused)).toEqual([]);

    bench.focused = false;
    expect(collectQuotaNotifications(NOW, bench.focused)).toEqual([]);
  });
});

describe("saying it once", () => {
  it("fires once however often the same reading is recomputed", () => {
    seedUsageStoreForTests("claude", null, [win(0.85)], NOW);
    expect(collectQuotaNotifications(NOW, bench.focused)).toHaveLength(1);
    expect(collectQuotaNotifications(NOW, bench.focused)).toEqual([]);
    expect(collectQuotaNotifications(NOW + 60_000, bench.focused)).toEqual([]);
  });

  it("stays quiet across a restart inside the same window", async () => {
    seedUsageStoreForTests("claude", null, [win(0.85)], NOW);
    expect(collectQuotaNotifications(NOW, bench.focused)).toHaveLength(1);
    await saveUsageStore(NOW);

    // The restart: everything in memory goes, and the snapshot comes back.
    resetUsageStoreForTests();
    await loadUsageStore(NOW);
    seedUsageStoreForTests("claude", null, [win(0.86)], NOW);

    expect(collectQuotaNotifications(NOW, bench.focused)).toEqual([]);
  });

  // A new `resetsAt` is a new window, so the dedupe has to let it through: the
  // key carries the reset, and a key whose reset has passed is pruned on save.
  it("fires again for the next window", () => {
    seedUsageStoreForTests("claude", null, [win(0.85)], NOW);
    expect(collectQuotaNotifications(NOW, bench.focused)).toHaveLength(1);

    seedUsageStoreForTests("claude", null, [win(0.85, "five_hour", LATER + 5 * 3600)], NOW);
    expect(collectQuotaNotifications(NOW, bench.focused)).toHaveLength(1);
  });

  // Reached after approaching is a second thing worth hearing, so the key
  // carries the state too.
  it("fires again when the same window goes from approaching to reached", () => {
    seedUsageStoreForTests("claude", null, [win(0.85)], NOW);
    expect(collectQuotaNotifications(NOW, bench.focused)).toHaveLength(1);

    seedUsageStoreForTests("claude", null, [win(1)], NOW);
    expect(collectQuotaNotifications(NOW, bench.focused)[0].body).toContain("has been reached");
  });
});

describe("what the settings silence", () => {
  it("sends nothing when notify is off, and does not burn the key doing it", () => {
    bench.usage = { claude: { accounts: { default: { notify: false } } } };
    seedUsageStoreForTests("claude", null, [win(1)], NOW);
    expect(collectQuotaNotifications(NOW, bench.focused)).toEqual([]);

    // Turning it back on still has the crossing to report: the window has not
    // reset, and nothing recorded it as said.
    bench.usage = { claude: { accounts: { default: { notify: true } } } };
    expect(collectQuotaNotifications(NOW, bench.focused)).toHaveLength(1);
  });

  it("sends nothing for an account showing no windows, or an agent turned off", () => {
    bench.usage = { claude: { accounts: { default: { windows: [] } } } };
    seedUsageStoreForTests("claude", null, [win(1)], NOW);
    expect(collectQuotaNotifications(NOW, bench.focused)).toEqual([]);

    bench.usage = {};
    bench.enabled = new Set();
    expect(collectQuotaNotifications(NOW, bench.focused)).toEqual([]);
  });

  // Taking a window off the strip is saying you do not want to hear about it,
  // and a notification is the loudest possible version of hearing about it.
  it("sends nothing about a window this account keeps off the titlebar", () => {
    bench.usage = { claude: { accounts: { work: { windows: ["seven_day"] } } } };
    seedUsageStoreForTests("claude", "work", [win(1)], NOW);
    expect(collectQuotaNotifications(NOW, bench.focused)).toEqual([]);

    // The other window on the same account still speaks: this is per window,
    // not per account.
    seedUsageStoreForTests("claude", "work", [win(1, "seven_day")], NOW);
    expect(collectQuotaNotifications(NOW, bench.focused)).toHaveLength(1);
  });

  // The threshold is the account's own, so two logins can warn at two points.
  it("warns at this account's own threshold", () => {
    bench.usage = { claude: { accounts: { default: { warnAt: 0.9 } } } };
    seedUsageStoreForTests("claude", null, [win(0.85)], NOW);
    expect(collectQuotaNotifications(NOW, bench.focused)).toEqual([]);

    seedUsageStoreForTests("claude", null, [win(0.92)], NOW);
    expect(collectQuotaNotifications(NOW, bench.focused)).toHaveLength(1);
  });
});
