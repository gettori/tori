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
  annotations: [],
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
  };
}

function catalog(agentId: string, models: CatalogModel[]): ModelCatalog {
  return {
    agentId,
    state: "probed",
    catalogue: { version: "1", probedAtMs: 0, models, modes: [], account: null },
    lastFailure: null,
  };
}

const allReady = () => true;
const noneSignedOut = () => false;
const noneProbing = () => false;

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
      catalogs: [catalog("claude", [model("sonnet", "claude-sonnet-5", "Sonnet")])],
      ready: () => false,
      signedOut: noneSignedOut,
      probing: (id) => id === "claude",
    });
    expect(rows[0].health).toEqual({ kind: "probing" });
  });

  it("lists no models for an agent nobody has probed", () => {
    const rows = paletteProviders({
      adapters,
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
      ready: allReady,
      signedOut: noneSignedOut,
      probing: noneProbing,
    });
    expect(rows[0].splitModels).toBe(true);
  });
});
