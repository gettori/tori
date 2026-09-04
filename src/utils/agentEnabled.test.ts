// Which agents this install offers: the stored answer, the health gate, and the
// sentence each refusal gets.
//
// The rule under test is that these are two facts and both have to say yes. The
// asymmetry matters more than the conjunction: a definite "signed out" is a no,
// and the `unknown` that four of the seven bundled agents report forever is not.
import { describe, it, expect, vi, beforeEach } from "vitest";

const bench = vi.hoisted(() => ({
  enabled: {} as Record<string, boolean>,
  loaded: true,
  saved: [] as unknown[],
}));

vi.mock("../panels/Settings/settingsStore", () => ({
  get settings() {
    return { agent: { enabled: bench.enabled } };
  },
  settingsLoaded: () => bench.loaded,
  saveSettings: async (next: unknown) => {
    bench.saved.push(next);
  },
}));

// The health layer, stood in for rather than driven through a real sweep: what
// a given row means is `agentHealth`'s own test, and what this module does with
// the answer is this one's. `unswept` is the case the two rules disagree on -
// `agentReady` says yes, the switch says not yet.
const health = vi.hoisted(() => ({
  unswept: new Set<string>(),
  notInstalled: new Set<string>(),
  // Keyed `<agent>:<profile>`, so a test can sign one account out and leave the
  // other alone, which is the whole of what the per-account gate has to do.
  signedOut: new Set<string>(),
}));
const key = (id: string, profile: string | null = null) => `${id}:${profile ?? ""}`;
vi.mock("./agentHealth", () => ({
  agentReady: (id: string, profile: string | null = null) =>
    !health.notInstalled.has(id) && !health.signedOut.has(`${id}:${profile ?? ""}`),
  profileSignedOut: (id: string, profile: string | null = null) =>
    health.signedOut.has(`${id}:${profile ?? ""}`),
  agentHealthFor: (id: string) =>
    health.unswept.has(id)
      ? null
      : {
          id,
          status: health.notInstalled.has(id) ? "notFound" : "versionMatch",
          signIn: health.signedOut.has(`${id}:`) ? "signedOut" : "unknown",
        },
}));

const adapters = vi.hoisted(() => ({
  list: [] as { id: string; label: string; chat: unknown }[],
}));
vi.mock("./agents", async (orig) => {
  const actual = await orig<typeof import("./agents")>();
  return {
    ...actual,
    agents: () => adapters.list,
    findAdapter: (id: string) => adapters.list.find((a) => a.id === id) ?? { id, label: id },
  };
});

const {
  agentChosen,
  agentEnabled,
  agentOffReason,
  draftChatAgent,
  enableBlockedReason,
  enabledChatAgents,
  setAgentEnabled,
} = await import("./agentEnabled");

beforeEach(() => {
  bench.enabled = {};
  bench.loaded = true;
  bench.saved = [];
  health.unswept.clear();
  health.notInstalled.clear();
  health.signedOut.clear();
  adapters.list = [
    { id: "claude", label: "Claude", chat: {} },
    { id: "codex", label: "Codex", chat: {} },
    { id: "gemini", label: "Gemini", chat: {} },
    { id: "shellish", label: "Shellish", chat: null },
  ];
});

describe("what counts as enabled", () => {
  it("is off for an agent nobody has answered for", () => {
    expect(agentChosen("claude")).toBe(false);
    expect(agentEnabled("claude")).toBe(false);
  });

  it("needs the stored answer and a usable install, both", () => {
    bench.enabled = { claude: true, codex: true };
    health.notInstalled.add("codex");
    expect(agentEnabled("claude")).toBe(true);
    expect(agentEnabled("codex")).toBe(false);
  });

  // The asymmetry the four probe-less agents depend on: `unknown` is ignorance,
  // and reading it as a refusal would make them permanently un-offerable.
  it("blocks a definite signed-out and lets unknown through", () => {
    expect(enableBlockedReason("gemini")).toBeNull();
    health.signedOut.add(key("gemini"));
    expect(enableBlockedReason("gemini")).toBe("Sign in first");
    health.signedOut.clear();
    health.notInstalled.add("gemini");
    expect(enableBlockedReason("gemini")).toBe("Install it first");
  });

  // Turning one on takes a verdict; keeping one on does not. Otherwise every
  // picker would empty for the second or two a cold sweep takes.
  it("will not turn on an agent nothing has answered for, but keeps one on", () => {
    health.unswept.add("claude");
    expect(enableBlockedReason("claude")).toBe("Still being checked");
    bench.enabled = { claude: true };
    expect(agentEnabled("claude")).toBe(true);
  });
});

describe("the sentence a refusal gets", () => {
  it("tells a setting apart from a broken install", () => {
    expect(agentOffReason("claude")).toBe("Claude is turned off in Settings");
    bench.enabled = { claude: true };
    health.notInstalled.add("claude");
    expect(agentOffReason("claude")).toBe("Claude is not installed");
    health.notInstalled.clear();
    health.signedOut.add(key("claude"));
    expect(agentOffReason("claude")).toBe("Claude is signed out");
  });

  // The failure this is here for: a draft on Fonn refused because the personal
  // login expired is a refusal the user cannot act on from that tab, and one
  // let through because Fonn is fine is a session that will not start.
  it("answers for the account asked about, in the same words either way", () => {
    bench.enabled = { claude: true };
    health.signedOut.add(key("claude"));
    expect(agentOffReason("claude", "fonn")).toBeNull();
    expect(agentOffReason("claude", null)).toBe("Claude is signed out");

    health.signedOut.clear();
    health.signedOut.add(key("claude", "fonn"));
    expect(agentOffReason("claude", null)).toBeNull();
    expect(agentOffReason("claude", "fonn")).toBe("Claude is signed out");
  });

  it("says nothing at all before the settings file has been read", () => {
    bench.loaded = false;
    expect(agentOffReason("claude")).toBeNull();
  });
});

describe("writing the answer", () => {
  it("stores a yes and deletes a no, rather than recording every glance", () => {
    bench.enabled = { codex: true };
    setAgentEnabled("claude", true);
    expect((bench.saved[0] as { agent: { enabled: unknown } }).agent.enabled).toEqual({
      codex: true,
      claude: true,
    });
    setAgentEnabled("codex", false);
    expect((bench.saved[1] as { agent: { enabled: unknown } }).agent.enabled).toEqual({});
  });
});

describe("which agent a new draft opens on", () => {
  it("keeps the remembered one while it is still offered", () => {
    bench.enabled = { claude: true, codex: true };
    expect(draftChatAgent("codex")).toBe("codex");
  });

  it("falls to the first offered agent when the remembered one is not", () => {
    bench.enabled = { codex: true };
    expect(draftChatAgent("claude")).toBe("codex");
    expect(draftChatAgent("ghost")).toBe("codex");
  });

  // Null rather than claude: with nothing offered there is no honest answer,
  // and a fallback would make the setting a suggestion.
  it("answers nothing when this install offers nothing", () => {
    expect(draftChatAgent("claude")).toBeNull();
  });

  it("never offers a PTY-only adapter as a chat", () => {
    bench.enabled = { shellish: true };
    expect(enabledChatAgents()).toEqual([]);
    expect(draftChatAgent(null)).toBeNull();
  });
});
