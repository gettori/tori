// The half that spawns a process, and the three things that stop it.
//
// `usagePoll.test.ts` covers the schedule itself. What is held here is the
// wiring around it: an agent nobody enabled, an account showing no windows, and
// a read that failed are all reasons not to spawn anything, and none of them are
// the scheduler's business.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const bench = vi.hoisted(() => ({
  enabled: new Set<string>(["codex"]),
  usage: {} as Record<string, { accounts?: Record<string, { windows?: string[] }> }>,
  chats: [] as { agentId: string }[],
  answer: null as unknown,
  fails: false,
  calls: 0,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd !== "usage_probe_codex") return undefined;
    bench.calls += 1;
    if (bench.fails) throw new Error("codex is not installed");
    return bench.answer;
  }),
}));

vi.mock("../panels/Settings/settingsStore", () => ({
  get settings() {
    return { agent: { usage: bench.usage } };
  },
  saveSettings: async () => {},
}));

vi.mock("./agentEnabled", () => ({ agentEnabled: (id: string) => bench.enabled.has(id) }));

vi.mock("./chatSessions", () => ({ liveChats: () => bench.chats }));

const adapters = [{ id: "codex", label: "Codex", usage: { sources: ["cli"] }, usage_reason: null }];
vi.mock("./agents", async (orig) => {
  const actual = await orig<typeof import("./agents")>();
  return { ...actual, findAdapter: (id: string) => adapters.find((a) => a.id === id) ?? { id, label: id } };
});

const { pollUsage, resetUsageProbeForTests, usageIdentity } = await import("./usageProbe");
const { resetUsageStoreForTests, windowsFor } = await import("./usageStore");
const { BASE_BACKOFF_MS } = await import("./usagePoll");

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);

const ANSWER = {
  email: "codex-user@example.com",
  planType: "plus",
  credits: { hasCredits: false, unlimited: false, balance: "0" },
  reachedType: null,
  windows: [{ kind: "five_hour", utilization: 0.03, resetsAt: 1_788_665_968, status: null, reachedType: null }],
};

/** The invoke resolves on a microtask, so a poll has to be let through before
 *  anything it wrote can be read back. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  bench.enabled = new Set(["codex"]);
  bench.usage = {};
  bench.chats = [];
  bench.answer = ANSWER;
  bench.fails = false;
  bench.calls = 0;
  resetUsageStoreForTests();
  resetUsageProbeForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a read that answers", () => {
  it("files the windows under the cli rung and keeps the identity", async () => {
    pollUsage("codex", "hover");
    await settle();

    const windows = windowsFor("codex", null);
    expect(windows).toHaveLength(1);
    expect(windows[0].source).toBe("cli");
    expect(windows[0].utilization).toBe(0.03);
    expect(usageIdentity("codex", null)?.email).toBe("codex-user@example.com");
    expect(usageIdentity("codex", null)?.planType).toBe("plus");
  });
});

describe("what never spawns a process", () => {
  it("an agent nobody has a read path for", async () => {
    pollUsage("claude", "hover");
    await settle();
    expect(bench.calls).toBe(0);
  });

  it("an agent that is turned off", async () => {
    bench.enabled = new Set();
    pollUsage("codex", "hover");
    await settle();
    expect(bench.calls).toBe(0);
  });

  // An account with no chip lit is the user's own no, and it has to reach the
  // thing that does the spawning, not only the thing that draws a bar.
  it("an account showing no windows at all", async () => {
    bench.usage = { codex: { accounts: { default: { windows: [] } } } };
    pollUsage("codex", "hover");
    await settle();
    expect(bench.calls).toBe(0);
  });

  // Per account, so one login saying no does not silence the other.
  it("only the account that said no", async () => {
    bench.usage = { codex: { accounts: { default: { windows: [] } } } };
    pollUsage("codex", "hover", "work");
    await settle();
    expect(bench.calls).toBe(1);
  });
});

describe("a read that failed", () => {
  it("backs off, and keeps whatever the last good one said", async () => {
    pollUsage("codex", "hover");
    await settle();
    expect(windowsFor("codex", null)).toHaveLength(1);

    bench.fails = true;
    vi.setSystemTime(NOW + 60_000);
    pollUsage("codex", "hover");
    await settle();
    expect(bench.calls).toBe(2);
    // The reading survives the failure: a stale number showing its age beats an
    // error replacing it.
    expect(windowsFor("codex", null)).toHaveLength(1);

    // Inside the backoff, even for a hover, which is the user asking directly.
    vi.setSystemTime(NOW + 60_000 + BASE_BACKOFF_MS - 1);
    pollUsage("codex", "hover");
    await settle();
    expect(bench.calls).toBe(2);

    bench.fails = false;
    vi.setSystemTime(NOW + 60_000 + BASE_BACKOFF_MS);
    pollUsage("codex", "hover");
    await settle();
    expect(bench.calls).toBe(3);
  });
});
