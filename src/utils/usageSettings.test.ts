// Which rung Sway climbs for an agent, resolved from two halves that neither
// one of them can answer alone.
//
// The rule under test is the one the whole map turns on: **no entry is not
// "off"**. An agent nobody has answered for takes the first rung its adapter
// declares, so a passive reading that costs nothing arrives without an opt-in,
// while a stored `off` is the user's own no and outlives every adapter bump.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { UsageSettings } from "../panels/Settings/settingsStore";

const bench = vi.hoisted(() => ({
  usage: {} as Record<string, UsageSettings>,
  saved: [] as { agent?: { usage?: Record<string, UsageSettings> } }[],
}));

vi.mock("../panels/Settings/settingsStore", () => ({
  get settings() {
    return { agent: { usage: bench.usage } };
  },
  saveSettings: async (next: unknown) => {
    bench.saved.push(next as { agent?: { usage?: Record<string, UsageSettings> } });
  },
}));

// The adapter half, stood in for: what a `[usage]` table means is the loader's
// own test (`agents.rs`), and what this module does with the resolved answer is
// this one's.
const adapters = vi.hoisted(() => ({
  list: [] as { id: string; usage?: { sources: string[] } | null; usage_reason?: string | null }[],
}));
vi.mock("./agents", async (orig) => {
  const actual = await orig<typeof import("./agents")>();
  return {
    ...actual,
    findAdapter: (id: string) => adapters.list.find((a) => a.id === id) ?? { id },
  };
});

const {
  accountOnStrip,
  declaredRungs,
  resolvedUsage,
  setAccountOnStrip,
  setUsage,
  usageDetail,
  usageNotify,
  usageSource,
  usageUnavailableReason,
} = await import("./usageSettings");

/** The last thing written, in the shape the store would hold it. */
const lastSaved = () => bench.saved[bench.saved.length - 1]?.agent?.usage ?? {};

beforeEach(() => {
  bench.usage = {};
  bench.saved = [];
  adapters.list = [
    { id: "claude", usage: { sources: ["sessions", "token"] }, usage_reason: null },
    { id: "codex", usage: null, usage_reason: "this adapter predates the usage table (schema 4)" },
    { id: "gemini", usage: null, usage_reason: "this adapter declares no usage source" },
  ];
});

describe("resolving the source", () => {
  it("takes the adapter's first declared rung for an agent nobody has answered for", () => {
    expect(usageSource("claude")).toBe("sessions");
    expect(declaredRungs("claude")).toEqual(["sessions", "token"]);
  });

  it("is off for an adapter that declares no ladder, whatever the file says", () => {
    expect(usageSource("codex")).toBe("off");
    bench.usage = { codex: { source: "token", detail: "standard", notify: true, hiddenProfiles: [] } };
    expect(usageSource("codex")).toBe("off");
  });

  it("keeps a stored off, which is the user's own no rather than a default", () => {
    bench.usage = { claude: { source: "off", detail: "standard", notify: true, hiddenProfiles: [] } };
    expect(usageSource("claude")).toBe("off");
  });

  it("honours a stored rung the adapter declares", () => {
    bench.usage = { claude: { source: "token", detail: "standard", notify: true, hiddenProfiles: [] } };
    expect(usageSource("claude")).toBe("token");
  });

  // The ladder is cumulative, so "the deepest source available" resolves to the
  // deepest one still available. Falling to `off` would silence the free
  // passive rung over a downgrade nobody asked for.
  it("falls back to the first rung when the stored one is no longer declared", () => {
    bench.usage = { claude: { source: "cli", detail: "standard", notify: true, hiddenProfiles: [] } };
    expect(usageSource("claude")).toBe("sessions");
  });

  it("carries the loader's reason only while there is no rung to offer", () => {
    expect(usageUnavailableReason("claude")).toBeNull();
    expect(usageUnavailableReason("codex")).toBe("this adapter predates the usage table (schema 4)");
    expect(usageUnavailableReason("gemini")).toBe("this adapter declares no usage source");
  });
});

describe("the rest of the entry", () => {
  it("defaults detail to standard and notify to on", () => {
    expect(usageDetail("claude")).toBe("standard");
    expect(usageNotify("claude")).toBe(true);
    expect(resolvedUsage("claude")).toEqual({
      source: "sessions",
      detail: "standard",
      notify: true,
      hiddenProfiles: [],
    });
  });

  // Answering one control must not silently answer the others. A patch merged
  // onto the type's defaults would store `source: "off"` for an agent whose
  // control was reading "Sessions" at the moment the user flipped notify.
  it("writes a partial answer against what was resolved, not against the type's defaults", async () => {
    await setUsage("claude", { notify: false });
    expect(lastSaved().claude).toEqual({
      source: "sessions",
      detail: "standard",
      notify: false,
      hiddenProfiles: [],
    });
  });
});

describe("which accounts reach the strip", () => {
  it("always shows the default account, whatever the file names", () => {
    bench.usage = { claude: { source: "sessions", detail: "standard", notify: true, hiddenProfiles: ["default"] } };
    expect(accountOnStrip("claude", null)).toBe(true);
    expect(accountOnStrip("claude", "default")).toBe(true);
  });

  it("hides a named account and shows one nobody hid", () => {
    bench.usage = { claude: { source: "sessions", detail: "standard", notify: true, hiddenProfiles: ["work"] } };
    expect(accountOnStrip("claude", "work")).toBe(false);
    expect(accountOnStrip("claude", "fonn")).toBe(true);
  });

  it("stores no entry for the default account, since it cannot be hidden", async () => {
    await setAccountOnStrip("claude", null, false);
    expect(bench.saved).toHaveLength(0);
  });

  it("adds and removes a named account without duplicating it", async () => {
    await setAccountOnStrip("claude", "work", false);
    expect(lastSaved().claude.hiddenProfiles).toEqual(["work"]);

    bench.usage = lastSaved();
    await setAccountOnStrip("claude", "work", false);
    expect(lastSaved().claude.hiddenProfiles).toEqual(["work"]);

    bench.usage = lastSaved();
    await setAccountOnStrip("claude", "work", true);
    expect(lastSaved().claude.hiddenProfiles).toEqual([]);
  });
});
