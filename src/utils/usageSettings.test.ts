// What each account says about its own quota, resolved from two halves that
// neither one of them can answer alone.
//
// The rule the whole map turns on: **no entry is not "off"**. An account nobody
// has answered for shows the two windows that cost nothing to read, so a free
// reading arrives without an opt-in, while a stored empty list is the user's own
// no and outlives every adapter bump.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { UsageSettings } from "../panels/Settings/settingsStore";

const bench = vi.hoisted(() => ({
  usage: {} as Record<string, UsageSettings>,
  warnAtFraction: 0.8,
  saved: [] as { agent?: { usage?: Record<string, UsageSettings> } }[],
}));

vi.mock("../panels/Settings/settingsStore", () => ({
  get settings() {
    return { agent: { usage: bench.usage }, budgets: { warnAtFraction: bench.warnAtFraction } };
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
  accountWindows,
  chipFor,
  declaredRungs,
  offersModelWindow,
  setUsageNotify,
  setUsageWarnAt,
  setWindowShown,
  showsWindow,
  usageNotify,
  usageRungFor,
  usageUnavailableReason,
  usageWarnAt,
} = await import("./usageSettings");

/** The last thing written, in the shape the store would hold it. */
const lastSaved = () => bench.saved[bench.saved.length - 1]?.agent?.usage ?? {};
const account = (agentId: string, id = "default") => lastSaved()[agentId]?.accounts?.[id];

beforeEach(() => {
  bench.usage = {};
  bench.saved = [];
  bench.warnAtFraction = 0.8;
  adapters.list = [
    { id: "claude", usage: { sources: ["sessions", "token"] }, usage_reason: null },
    { id: "codex", usage: { sources: ["cli"] }, usage_reason: null },
    { id: "gemini", usage: null, usage_reason: "this adapter declares no usage source" },
  ];
});

describe("which windows an account shows", () => {
  it("gives an account nobody has answered for the two that cost nothing", () => {
    expect(accountWindows("claude", null)).toEqual(["five_hour", "seven_day"]);
    expect(showsWindow("claude", null, "model_week")).toBe(false);
    expect(declaredRungs("claude")).toEqual(["sessions", "token"]);
  });

  it("reads a stored empty list as the user's own no, not as an absent answer", () => {
    bench.usage = { claude: { accounts: { default: { windows: [] } } } };
    expect(accountWindows("claude", null)).toEqual([]);
  });

  it("shows nothing for an adapter that declares no ladder, whatever the file says", () => {
    bench.usage = { gemini: { accounts: { default: { windows: ["five_hour"] } } } };
    expect(accountWindows("gemini", null)).toEqual([]);
  });

  it("keeps each account's answer to itself", () => {
    bench.usage = { claude: { accounts: { work: { windows: ["five_hour"] } } } };
    expect(accountWindows("claude", "work")).toEqual(["five_hour"]);
    expect(accountWindows("claude", null)).toEqual(["five_hour", "seven_day"]);
  });

  it("files every window a deep read adds under the one chip that authorised it", () => {
    expect(chipFor("five_hour")).toBe("five_hour");
    expect(chipFor("seven_day")).toBe("seven_day");
    expect(chipFor("seven_day_fable")).toBe("model_week");
    expect(chipFor("extra_usage")).toBe("model_week");
  });

  it("carries the loader's reason only while there is no rung to offer", () => {
    expect(usageUnavailableReason("claude")).toBeNull();
    expect(usageUnavailableReason("gemini")).toBe("this adapter declares no usage source");
  });
});

describe("the rung the chips imply", () => {
  it("reads on the free rung for an account nobody has answered for", () => {
    expect(usageRungFor("claude", null)).toBe("sessions");
    expect(usageRungFor("codex", null)).toBe("cli");
  });

  it("reads nothing at all when no chip is lit", () => {
    bench.usage = { claude: { accounts: { default: { windows: [] } } } };
    expect(usageRungFor("claude", null)).toBe("off");
    expect(usageRungFor("gemini", null)).toBe("off");
  });

  // The one read that opens the login Keychain, and the one chip that asks for
  // it. A user who wanted the five-hour bar did not ask for a Keychain prompt.
  it("climbs to the account token only for the model window", () => {
    bench.usage = { claude: { accounts: { default: { windows: ["five_hour", "seven_day"] } } } };
    expect(usageRungFor("claude", null)).toBe("sessions");

    bench.usage = { claude: { accounts: { default: { windows: ["five_hour", "model_week"] } } } };
    expect(usageRungFor("claude", null)).toBe("token");
  });

  it("offers the model window only where a rung can answer one", () => {
    expect(offersModelWindow("claude")).toBe(true);
    expect(offersModelWindow("codex")).toBe(false);
  });

  it("leaves the other accounts of one agent where they were", () => {
    bench.usage = { claude: { accounts: { default: { windows: ["model_week"] } } } };
    expect(usageRungFor("claude", null)).toBe("token");
    expect(usageRungFor("claude", "work")).toBe("sessions");
  });
});

describe("writing an answer", () => {
  // The first press has to store what the user was looking at plus their
  // change. Writing only the chip they pressed would read back as "everything
  // else off", which is not what the screen was showing them.
  it("stores the resolved list plus the press, in the ladder's order", async () => {
    await setWindowShown("claude", null, "model_week", true);
    expect(account("claude")?.windows).toEqual(["five_hour", "seven_day", "model_week"]);
  });

  it("takes one back out without touching the rest", async () => {
    bench.usage = { claude: { accounts: { default: { windows: ["five_hour", "seven_day"] } } } };
    await setWindowShown("claude", null, "seven_day", false);
    expect(account("claude")?.windows).toEqual(["five_hour"]);
  });

  // Answering one control must not silently answer the others: an absent
  // `windows` is "never asked", and a write that filled it in would freeze
  // today's free pair against a later adapter that reports a third.
  it("writes only the field that was answered", async () => {
    await setUsageNotify("claude", null, false);
    expect(account("claude")).toEqual({ notify: false });

    bench.usage = { claude: { accounts: { default: { notify: false } } } };
    await setUsageWarnAt("claude", null, 0.6);
    expect(account("claude")).toEqual({ notify: false, warnAt: 0.6 });
  });

  it("keeps one account's answer off the others", async () => {
    bench.usage = { claude: { accounts: { work: { windows: [] } } } };
    await setUsageNotify("claude", null, false);
    expect(account("claude", "work")).toEqual({ windows: [] });
    expect(account("claude", "default")).toEqual({ notify: false });
  });
});

describe("how full is too full, and how loud", () => {
  it("follows the shared threshold until this account moves its own", () => {
    expect(usageWarnAt("claude", null)).toBe(0.8);
    bench.warnAtFraction = 0.9;
    expect(usageWarnAt("claude", null)).toBe(0.9);

    bench.usage = { claude: { accounts: { default: { warnAt: 0.6 } } } };
    expect(usageWarnAt("claude", null)).toBe(0.6);
    expect(usageWarnAt("claude", "work")).toBe(0.9);
  });

  it("notifies unless the account said not to", () => {
    expect(usageNotify("claude", null)).toBe(true);
    bench.usage = { claude: { accounts: { default: { notify: false } } } };
    expect(usageNotify("claude", null)).toBe(false);
    expect(usageNotify("claude", "work")).toBe(true);
  });
});
