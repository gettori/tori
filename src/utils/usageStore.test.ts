// The account-level quota store: what merges, what is absent, and what is only
// said once.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

const invokes: { cmd: string; args: Record<string, unknown> }[] = [];
let loaded: unknown = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown> = {}) => {
    invokes.push({ cmd, args });
    return Promise.resolve(cmd === "usage_snapshot_load" ? loaded : null);
  },
}));

const {
  accountKey,
  accountsWithReadings,
  loadUsageStore,
  pruneFired,
  recordReadings,
  resetUsageStoreForTests,
  saveUsageStore,
  shouldAnnounce,
  temporalOf,
  usageSnapshot,
  windowFor,
  windowsFor,
} = await import("./usageStore");
const { quotaState } = await import("./chatRateLimit");

const NOW = 1_788_500_000_000;
/** Comfortably in the future of `NOW`, in the epoch **seconds** every source
 *  reports resets in. */
const FUTURE = Math.floor(NOW / 1000) + 3 * 60 * 60;

const reading = (kind: string, over: Record<string, unknown> = {}) => ({
  kind,
  utilization: 0.2,
  resetsAt: FUTURE,
  status: null,
  reachedType: null,
  ...over,
});

beforeEach(() => {
  invokes.length = 0;
  loaded = null;
  resetUsageStoreForTests();
});

describe("the account key", () => {
  // One account, one key. The tab model spells the default account `null` and
  // the backend spells it `"default"`; two keys for one login would put a chat's
  // readings somewhere the titlebar never looks.
  it("gives the default account one spelling", () => {
    expect(accountKey("claude", null)).toBe(accountKey("claude", "default"));
    expect(accountKey("claude", "globex")).not.toBe(accountKey("claude", null));
  });
});

describe("merging samples", () => {
  it("takes the newest sample when two chats report the same account", () => {
    recordReadings("claude", null, "sessions", [reading("five_hour", { utilization: 0.15 })], NOW);
    recordReadings("claude", null, "sessions", [reading("five_hour", { utilization: 0.42 })], NOW + 1000);

    expect(windowFor("claude", null, "five_hour")?.utilization).toBe(0.42);
    expect(windowsFor("claude", null)).toHaveLength(1);
  });

  it("ignores a sample older than the one on record", () => {
    recordReadings("claude", null, "sessions", [reading("five_hour", { utilization: 0.42 })], NOW + 1000);
    recordReadings("claude", null, "sessions", [reading("five_hour", { utilization: 0.15 })], NOW);

    expect(windowFor("claude", null, "five_hour")?.utilization).toBe(0.42);
  });

  // The merge is per window kind for exactly this: the token rung is the only
  // source of the model-scoped window, and a passive frame naming only the two
  // generic ones must not blink it out on the next turn.
  it("keeps a window a deeper source alone returned when a passive sample lands", () => {
    recordReadings(
      "claude",
      null,
      "token",
      [reading("five_hour"), reading("seven_day"), reading("seven_day_opus", { utilization: 0.6 })],
      NOW,
    );
    recordReadings("claude", null, "sessions", [reading("five_hour"), reading("seven_day")], NOW + 1000);

    const scoped = windowFor("claude", null, "seven_day_opus");
    expect(scoped?.utilization).toBe(0.6);
    expect(scoped?.source).toBe("token");
    expect(windowsFor("claude", null).map((w) => w.kind)).toEqual(["five_hour", "seven_day", "seven_day_opus"]);
  });

  // Absence is a property of "nothing ever returned it", never of the latest
  // sample. An absent window renders nothing; a zero would read as an untouched
  // quota.
  it("has no window nothing has ever returned", () => {
    recordReadings("claude", null, "sessions", [reading("five_hour")], NOW);

    expect(windowFor("claude", null, "seven_day")).toBeNull();
    expect(windowFor("codex", null, "five_hour")).toBeNull();
  });

  it("keeps two accounts of one agent apart", () => {
    recordReadings("claude", null, "sessions", [reading("five_hour", { utilization: 0.1 })], NOW);
    recordReadings("claude", "globex", "sessions", [reading("five_hour", { utilization: 0.9 })], NOW);

    expect(windowFor("claude", null, "five_hour")?.utilization).toBe(0.1);
    expect(windowFor("claude", "globex", "five_hour")?.utilization).toBe(0.9);
    expect(accountsWithReadings()).toHaveLength(2);
  });
});

describe("how old a reading is", () => {
  it("is live when it was just taken", () => {
    recordReadings("claude", null, "sessions", [reading("five_hour")], NOW);
    expect(temporalOf(windowFor("claude", null, "five_hour")!, NOW)).toBe("live");
  });

  it("is stale once nobody has asked for a while", () => {
    recordReadings("claude", null, "sessions", [reading("five_hour")], NOW);
    expect(temporalOf(windowFor("claude", null, "five_hour")!, NOW + 20 * 60 * 1000)).toBe("stale");
  });

  // Past its reset the level is wrong, not merely old. Drawn dimmed it would
  // report 20% on a window that has since emptied.
  it("is expired past its reset, however fresh the sample", () => {
    recordReadings("claude", null, "sessions", [reading("five_hour")], NOW);
    const past = FUTURE * 1000 + 1000;
    expect(temporalOf(windowFor("claude", null, "five_hour")!, past)).toBe("expired");
  });
});

describe("announcing a transition once", () => {
  const warned = () => ({
    ...reading("seven_day", { utilization: 0.88 }),
    sampledAt: NOW,
    source: "sessions" as const,
  });

  it("fires once however many events repeat it", () => {
    const r = warned();
    expect(quotaState(r, 0.8, NOW)).toBe("approaching");
    expect(shouldAnnounce("claude", null, r, "approaching")).toBe(true);
    expect(shouldAnnounce("claude", null, r, "approaching")).toBe(false);
    expect(shouldAnnounce("claude", null, r, "approaching")).toBe(false);
  });

  // Approaching and reached are separate transitions, so climbing past the
  // threshold and then hitting the wall are two pieces of news, not one.
  it("fires reached even after approaching was said for the same window", () => {
    const r = warned();
    expect(shouldAnnounce("claude", null, r, "approaching")).toBe(true);
    expect(shouldAnnounce("claude", null, r, "reached")).toBe(true);
  });

  it("never announces ok or expired", () => {
    expect(shouldAnnounce("claude", null, warned(), "ok")).toBe(false);
    expect(shouldAnnounce("claude", null, warned(), "expired")).toBe(false);
  });

  // A new `resetsAt` is a new window, and the notice is about the window rather
  // than about the account.
  it("re-arms on a new reset", () => {
    expect(shouldAnnounce("claude", null, warned(), "approaching")).toBe(true);
    const next = { ...warned(), resetsAt: FUTURE + 7 * 24 * 60 * 60 };
    expect(shouldAnnounce("claude", null, next, "approaching")).toBe(true);
  });

  it("keeps two accounts' notices apart", () => {
    expect(shouldAnnounce("claude", null, warned(), "approaching")).toBe(true);
    expect(shouldAnnounce("claude", "globex", warned(), "approaching")).toBe(true);
  });
});

describe("the snapshot", () => {
  it("does not re-fire after a reload inside the same window", async () => {
    const r = { ...reading("seven_day", { utilization: 0.88 }), sampledAt: NOW, source: "sessions" as const };
    expect(shouldAnnounce("claude", null, r, "approaching")).toBe(true);
    const snap = usageSnapshot(NOW);

    resetUsageStoreForTests();
    loaded = snap;
    await loadUsageStore(NOW);

    expect(shouldAnnounce("claude", null, r, "approaching")).toBe(false);
  });

  // The stamp is what makes the set prunable. Without it the record of one
  // window's notice would swallow the next window's.
  it("drops fired keys whose reset has passed", () => {
    const past = Math.floor(NOW / 1000) - 60;
    const kept = pruneFired({ live: FUTURE, gone: past, undatable: null }, NOW);
    expect(Object.keys(kept)).toEqual(["live"]);
  });

  it("saves the pruned set, not the one it was holding", async () => {
    const live = { ...reading("five_hour"), sampledAt: NOW, source: "sessions" as const };
    const dead = {
      ...reading("seven_day", { resetsAt: Math.floor(NOW / 1000) - 60 }),
      sampledAt: NOW,
      source: "sessions" as const,
    };
    shouldAnnounce("claude", null, live, "approaching");
    shouldAnnounce("claude", null, dead, "reached");
    expect(Object.keys(usageSnapshot(NOW).fired)).toHaveLength(1);

    await saveUsageStore(NOW);

    const sent = invokes.find((i) => i.cmd === "usage_snapshot_save")?.args.snapshot as { fired: object };
    expect(Object.keys(sent.fired)).toHaveLength(1);
  });

  it("reads its readings back", async () => {
    recordReadings("claude", "globex", "sessions", [reading("five_hour", { utilization: 0.33 })], NOW);
    const snap = usageSnapshot(NOW);

    resetUsageStoreForTests();
    expect(windowFor("claude", "globex", "five_hour")).toBeNull();
    loaded = snap;
    await loadUsageStore(NOW);

    expect(windowFor("claude", "globex", "five_hour")?.utilization).toBe(0.33);
  });

  // A corrupt or absent file is one cold start, never a titlebar that cannot
  // render.
  it("survives a snapshot that is not there", async () => {
    loaded = null;
    await loadUsageStore();
    expect(accountsWithReadings()).toEqual([]);
  });
});
