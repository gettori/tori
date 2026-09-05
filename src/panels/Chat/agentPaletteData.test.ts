import { describe, expect, it } from "vitest";
import {
  filterProviders,
  fixReason,
  lockedProvider,
  paletteProviders,
  splitModelDisplay,
} from "./agentPaletteData";
import type { Adapter, ChatConfig } from "../../utils/agents";
import type { CatalogModel, ModelCatalog } from "../../utils/modelCatalog";

const chat: ChatConfig = {
  transport: "claude_stream_json",
  program: "claude",
  base_args: [],
  session_id_args: [],
  resume_args: [],
  model_args: [],
  effort_args: [],
  mode_args: [],
  add_dir_args: [],
  modes: [],
  effort_extras: [],
  acp: { serve_client_fs: false },
};

function adapter(id: string, label: string, chatting = true): Adapter {
  return {
    id,
    label,
    program: id,
    base_args: [],
    yolo_args: [],
    resume_args: [],
    parser_kind: null,
    running_pattern: null,
    pty_quiet_ms: 2000,
    chat: chatting ? chat : null,
  };
}

function model(value: string, resolved: string, displayName: string): CatalogModel {
  return {
    value,
    resolvedModel: resolved,
    displayName,
    description: "",
    supportsEffort: false,
    supportedEffortLevels: [],
    supportsAutoMode: false,
    supportsFastMode: false,
    supportsAdaptiveThinking: false,
  };
}

function catalog(agentId: string, models: CatalogModel[], profileId = "default"): ModelCatalog {
  return {
    agentId,
    profileId,
    state: "probed",
    catalogue: { version: "1", probedAtMs: 0, models, modes: [], account: null },
    lastFailure: null,
  };
}

const allReady = () => true;
const noneSignedOut = () => false;
const noneProbing = () => false;
// Every row is about the default account unless a test says otherwise.
// Empty is a single-account install: `namedProfiles` withholds the list when
// there is nothing to tell apart, so the palette renders one plain row.
const oneAccount = () => [];
const DEFAULT = { id: "default", label: "Default" };
const FONN = { id: "fonn", label: "Fonn" };
const onPlan = (c: ModelCatalog, subscriptionType: string): ModelCatalog => ({
  ...c,
  catalogue: { ...c.catalogue!, account: { subscriptionType, organization: "", apiProvider: "firstParty" } },
});

describe("fixReason", () => {
  it("is null for a ready agent", () => {
    expect(fixReason("claude", allReady, noneSignedOut)).toBeNull();
  });

  it("tells a missing binary apart from a missing login", () => {
    expect(fixReason("claude", () => false, () => true)).toBe("Signed out");
    expect(fixReason("claude", () => false, () => false)).toBe("Not installed");
  });
});

describe("paletteProviders", () => {
  const adapters = [adapter("claude", "Claude"), adapter("codex", "Codex"), adapter("pty", "PtyOnly", false)];

  it("offers only chat-capable agents", () => {
    const rows = paletteProviders({
      adapters,
      profilesFor: oneAccount,
      catalogs: [],
      ready: allReady,
      signedOut: noneSignedOut,
      probing: noneProbing,
    });
    expect(rows.map((r) => r.agentId)).toEqual(["claude", "codex"]);
  });

  it("counts distinct models, not catalogue rows", () => {
    const rows = paletteProviders({
      adapters,
      profilesFor: oneAccount,
      catalogs: [
        catalog("claude", [
          model("default", "claude-sonnet-5", "Default"),
          model("sonnet", "claude-sonnet-5", "Sonnet"),
          model("haiku", "claude-haiku-4-5", "Haiku"),
        ]),
      ],
      ready: allReady,
      signedOut: noneSignedOut,
      probing: noneProbing,
    });
    expect(rows[0].health).toEqual({ kind: "count", count: 2 });
    // The count dedupes and the list does not: three ways to spell two models
    // are still three things to pick.
    expect(rows[0].models).toHaveLength(3);
  });

  it("keeps a broken agent visible but not selectable", () => {
    const rows = paletteProviders({
      adapters,
      profilesFor: oneAccount,
      catalogs: [catalog("codex", [model("gpt-5", "gpt-5", "GPT-5")])],
      ready: (id) => id !== "codex",
      signedOut: () => false,
      probing: noneProbing,
    });
    const codex = rows.find((r) => r.agentId === "codex")!;
    expect(codex.health).toEqual({ kind: "fix", reason: "Not installed" });
    expect(codex.selectable).toBe(false);
    expect(codex.models).toHaveLength(1);
  });

  it("says probing over anything else it could have said", () => {
    const rows = paletteProviders({
      adapters,
      profilesFor: oneAccount,
      catalogs: [catalog("claude", [model("sonnet", "claude-sonnet-5", "Sonnet")])],
      ready: () => false,
      signedOut: noneSignedOut,
      probing: (id) => id === "claude",
    });
    expect(rows[0].health).toEqual({ kind: "probing" });
  });

  // A catalogue is an account's answer, so an agent with two logins is two
  // rows. The provider row splits rather than the models pane sectioning,
  // because fuzzy search over one merged list returns the same model name twice
  // with nothing to say which account it would run on.
  describe("an agent with two accounts", () => {
    const twoAccounts = (id: string) => (id === "claude" ? [DEFAULT, FONN] : []);
    const both = [
      onPlan(catalog("claude", [model("opus", "claude-opus-5", "Opus")]), "Claude Max"),
      onPlan(
        catalog("claude", [model("sonnet", "claude-sonnet-5", "Sonnet")], "fonn"),
        "Claude Team",
      ),
      catalog("codex", [model("gpt-5", "gpt-5", "GPT-5")]),
    ];
    const rows = () =>
      paletteProviders({
        adapters,
        catalogs: both,
        profilesFor: twoAccounts,
        ready: allReady,
        signedOut: noneSignedOut,
        probing: noneProbing,
      });

    it("is one row per account, each named and keyed for itself", () => {
      const claude = rows().filter((r) => r.agentId === "claude");
      expect(claude.map((r) => r.label)).toEqual(["Claude / Default", "Claude / Fonn"]);
      expect(claude.map((r) => r.profile)).toEqual([null, "fonn"]);
      // `agentId` no longer tells the rows apart, so nothing may key on it.
      expect(new Set(claude.map((r) => r.key)).size).toBe(2);
    });

    it("gives each row its own account's models and plan", () => {
      const claude = rows().filter((r) => r.agentId === "claude");
      expect(claude[0].models.map((m) => m.value)).toEqual(["opus"]);
      expect(claude[1].models.map((m) => m.value)).toEqual(["sonnet"]);
      expect(claude.map((r) => r.plan)).toEqual(["Claude Max", "Claude Team"]);
    });

    // The other agent has one login, so it is one plain row: nothing about a
    // multi-account claude may leak into how codex is described.
    it("leaves a single-account agent exactly as it was", () => {
      const codex = rows().find((r) => r.agentId === "codex")!;
      expect(codex.label).toBe("Codex");
      expect(codex.profile).toBeNull();
      expect(codex.plan).toBeNull();
      expect(codex.models.map((m) => m.value)).toEqual(["gpt-5"]);
    });

    // Per account, from Phase 1's cached per-profile sign-in, and worded exactly
    // as an agent-level failure is: the row the user can act on is the one that
    // is broken, not both of them.
    it("marks only the account that is signed out", () => {
      const out = paletteProviders({
        adapters,
        catalogs: both,
        profilesFor: twoAccounts,
        ready: (_id, profile) => profile !== "fonn",
        signedOut: (_id, profile) => profile === "fonn",
        probing: noneProbing,
      }).filter((r) => r.agentId === "claude");

      expect(out[0].health).toEqual({ kind: "count", count: 1 });
      expect(out[0].selectable).toBe(true);
      expect(out[1].health).toEqual({ kind: "fix", reason: "Signed out" });
      expect(out[1].selectable).toBe(false);
    });

    // An account nobody has probed lists nothing rather than borrowing the
    // other one's models, which would offer rows it may not have.
    it("lists no models for an account with no answer of its own", () => {
      const rows = paletteProviders({
        adapters,
        catalogs: [catalog("claude", [model("opus", "claude-opus-5", "Opus")])],
        profilesFor: twoAccounts,
        ready: allReady,
        signedOut: noneSignedOut,
        probing: noneProbing,
      });
      const fonn = rows.find((r) => r.profile === "fonn")!;
      expect(fonn.models).toEqual([]);
      expect(fonn.health).toEqual({ kind: "count", count: 0 });
    });

    it("probes per account, so one row can be busy while the other is not", () => {
      const rows = paletteProviders({
        adapters,
        catalogs: both,
        profilesFor: twoAccounts,
        ready: allReady,
        signedOut: noneSignedOut,
        probing: (_id, profile) => profile === "fonn",
      }).filter((r) => r.agentId === "claude");
      expect(rows[0].health).toEqual({ kind: "count", count: 1 });
      expect(rows[1].health).toEqual({ kind: "probing" });
    });
  });

  it("lists no models for an agent nobody has probed", () => {
    const rows = paletteProviders({
      adapters,
      profilesFor: oneAccount,
      catalogs: null,
      ready: allReady,
      signedOut: noneSignedOut,
      probing: noneProbing,
    });
    expect(rows[0].models).toEqual([]);
    expect(rows[0].health).toEqual({ kind: "count", count: 0 });
  });
});

describe("filterProviders", () => {
  const providers = [
    lockedProvider(adapter("claude", "Claude"), [
      { value: "sonnet", resolvedModel: "claude-sonnet-5", label: "Sonnet", description: "", effortLevels: [], contextWindow: null, live: false, userConfigured: false, fastMode: false, supportsAutoMode: false },
      { value: "haiku", resolvedModel: "claude-haiku-4-5", label: "Haiku", description: "", effortLevels: [], contextWindow: null, live: false, userConfigured: false, fastMode: false, supportsAutoMode: false },
    ]),
    lockedProvider(adapter("codex", "Codex"), [
      { value: "gpt-5", resolvedModel: "gpt-5", label: "GPT-5", description: "", effortLevels: [], contextWindow: null, live: false, userConfigured: false, fastMode: false, supportsAutoMode: false },
    ]),
  ];

  it("passes everything through when nothing is typed", () => {
    expect(filterProviders(providers, "  ")).toHaveLength(2);
  });

  it("drops a provider whose name and models both miss", () => {
    const out = filterProviders(providers, "haiku");
    expect(out.map((p) => p.agentId)).toEqual(["claude"]);
    expect(out[0].models.map((m) => m.value)).toEqual(["haiku"]);
  });

  it("keeps a named provider's whole list", () => {
    const out = filterProviders(providers, "codex");
    expect(out.map((p) => p.agentId)).toEqual(["codex"]);
    expect(out[0].models).toHaveLength(1);
  });

  it("matches the value as well as the label", () => {
    const out = filterProviders(providers, "gpt");
    expect(out[0].models.map((m) => m.value)).toEqual(["gpt-5"]);
  });
});

// The two measured shapes, verbatim: opencode's provider/name pair and pi's
// vendor-qualified triple. Everything else must come back null, because this
// runs only on adapters that declared the convention and even they can name a
// model plainly.
describe("splitModelDisplay", () => {
  it("splits opencode's provider/name pair", () => {
    expect(splitModelDisplay("GitHub Copilot/Claude Sonnet 4.6", "github-copilot/claude-sonnet-4.6")).toEqual({
      name: "Claude Sonnet 4.6",
      segments: ["GitHub Copilot", "claude-sonnet-4.6"],
    });
  });

  it("peels pi's vendor prefix into the chain, and capitalises a bare id segment", () => {
    expect(splitModelDisplay("openrouter/Amazon: Nova 2 Lite", "openrouter/amazon/nova-2-lite-v1")).toEqual({
      name: "Nova 2 Lite",
      segments: ["Openrouter", "Amazon", "nova-2-lite-v1"],
    });
  });

  it("keeps a mixed-case chain segment as sent", () => {
    expect(splitModelDisplay("OpenCode Zen/Big Pickle", "opencode/big-pickle")).toEqual({
      name: "Big Pickle",
      segments: ["OpenCode Zen", "big-pickle"],
    });
  });

  it("declines a label with no path", () => {
    expect(splitModelDisplay("Sonnet", "sonnet")).toBeNull();
    expect(splitModelDisplay("", "")).toBeNull();
  });

  it("declines a label whose path leads nowhere", () => {
    expect(splitModelDisplay("openrouter/Amazon: ", "openrouter/amazon/x")).toBeNull();
  });

  it("carries the sweep's version, else the probe's own vintage", () => {
    const cat = catalog("claude", [model("sonnet", "claude-sonnet-5", "Sonnet")]);
    const input = {
      adapters: [adapter("claude", "Claude")],
      catalogs: [cat],
      profilesFor: oneAccount,
      ready: allReady,
      signedOut: noneSignedOut,
      probing: noneProbing,
    };
    expect(paletteProviders({ ...input, version: () => "2.0.0" })[0].version).toBe("2.0.0");
    // No sweep: the version the probe recorded is the list's own vintage.
    expect(paletteProviders(input)[0].version).toBe("1");
  });

  it("carries the flag from the adapter, not the strings", () => {
    const withFlag = adapter("opencode", "OpenCode");
    withFlag.chat = { ...chat, split_model_names: true };
    expect(lockedProvider(withFlag, []).splitModels).toBe(true);
    expect(lockedProvider(adapter("claude", "Claude"), []).splitModels).toBe(false);
    const rows = paletteProviders({
      adapters: [withFlag],
      catalogs: null,
      profilesFor: oneAccount,
      ready: allReady,
      signedOut: noneSignedOut,
      probing: noneProbing,
    });
    expect(rows[0].splitModels).toBe(true);
  });
});
