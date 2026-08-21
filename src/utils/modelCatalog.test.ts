// The two rules a cached catalogue is read by: how many models it really names,
// and whether it still describes the binary on disk.
//
// Both are mirrors of `catalog_probe.rs`, and both have a case that looks like
// an edge and is not: an alias-heavy catalogue is the normal one, and a
// version-less binary is two of the four agents Sway ships adapters for.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import probeSource from "../../src-tauri/src/catalog_probe.rs?raw";
import { refreshAgentHealth } from "./agentHealth";
import {
  __resetModelCatalogsForTests,
  CACHE_SHAPE,
  cachedModels,
  cachedOptions,
  catalogFor,
  distinctModelCount,
  ensureModelCatalogsLoaded,
  isStale,
  refreshCatalogIfDue,
  type CatalogModel,
  type ModelCatalog,
} from "./modelCatalog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invoked = vi.mocked(invoke);

const model = (value: string, resolvedModel: string): CatalogModel => ({
  value,
  resolvedModel,
  displayName: value,
  description: "",
  supportsEffort: false,
  supportedEffortLevels: [],
  supportsAutoMode: false,
});

const withModels = (models: CatalogModel[], version: string | null = "2.1.231"): ModelCatalog => ({
  agentId: "claude",
  state: "probed",
  catalogue: { version, probedAtMs: 0, models, modes: [], account: null },
  lastFailure: null,
});

describe("counting what a agent offers", () => {
  it("counts one model once, however many names the catalogue gives it", () => {
    const catalog = withModels([
      model("default", "claude-sonnet-5"),
      model("sonnet", "claude-sonnet-5"),
      model("claude-sonnet-5", "claude-sonnet-5"),
      model("haiku", "claude-haiku-4-5"),
    ]);
    expect(distinctModelCount(catalog)).toBe(2);
  });

  // The fallback is load-bearing, not defensive. A user-configured row carries
  // an **empty** `resolvedModel` on purpose: Sway passes that string to the CLI
  // unresolved and claims no resolution for it. Keying on that field alone makes
  // every configured model one model.
  it("does not collapse rows whose resolution Sway cannot claim", () => {
    const catalog = withModels([model("opusplan", ""), model("my-fine-tune", "")]);
    expect(distinctModelCount(catalog)).toBe(2);
  });

  it("answers zero for a agent with nothing remembered", () => {
    expect(distinctModelCount(undefined)).toBe(0);
    expect(
      distinctModelCount({ agentId: "solo", state: "neverProbed", catalogue: null, lastFailure: null }),
    ).toBe(0);
  });
});

describe("whether a remembered answer still describes the binary", () => {
  it("is stale when the versions differ and fresh when they match", () => {
    const catalog = withModels([model("sonnet", "claude-sonnet-5")]);
    expect(isStale(catalog, "2.1.231")).toBe(false);
    expect(isStale(catalog, "2.2.0")).toBe(true);
  });

  // Neither unknown-version case is evidence that anything changed, and treating
  // absence of evidence as staleness would re-probe a version-less binary on
  // every read. Such a agent comes back through Ask again.
  it("says fresh when either side has no version to compare", () => {
    expect(isStale(withModels([], null), "2.1.231")).toBe(false);
    expect(isStale(withModels([]), null)).toBe(false);
  });

  it("says fresh for a agent that never answered, which has nothing to be stale", () => {
    expect(isStale(undefined, "2.1.231")).toBe(false);
  });

  // The second comparison, and the one no version can stand in for: a cache
  // missing a field this build reads describes an older *Sway*, and the binary
  // on disk need not have moved at all.
  describe("and whether it still describes what this Sway reads", () => {
    it("reads an unstamped catalogue as the shape from before the stamp", () => {
      // Which is what makes introducing the mechanism invalidate nothing: every
      // catalogue on every machine is unstamped the day this ships.
      expect(withModels([]).catalogue?.shape).toBeUndefined();
      expect(isStale(withModels([]), "2.1.231")).toBe(false);
    });

    it("is stale when the cache is stamped below the shape this build wants", () => {
      const old = withModels([]);
      expect(isStale({ ...old, catalogue: { ...old.catalogue!, shape: CACHE_SHAPE - 1 } }, "2.1.231")).toBe(
        true,
      );
    });

    // A cache from a *newer* Sway carries every field this one reads, so there
    // is nothing to re-probe for. A downgrade is not a reason to spawn a binary.
    it("leaves a catalogue stamped above this build alone", () => {
      const newer = withModels([]);
      expect(
        isStale({ ...newer, catalogue: { ...newer.catalogue!, shape: CACHE_SHAPE + 1 } }, "2.1.231"),
      ).toBe(false);
    });

    // Written in Rust, judged here, so the number lives twice. Pinned rather
    // than trusted: a bump that lands in one language only would leave every
    // machine either re-probing forever or never.
    it("agrees with the constant the probe stamps", () => {
      const stamped = probeSource.match(/pub const CACHE_SHAPE: u32 = (\d+);/);
      expect(stamped?.[1]).toBe(String(CACHE_SHAPE));
    });
  });

  // A measurement is scoped to the binary it names, and a cached row decided
  // `disabled` against the version the probe recorded. On a binary that has
  // since changed, the rows Sway added come back off and the agent's own
  // published list is what is left. Otherwise a draft opened on an upgraded CLI
  // offers a level nothing measured for the one probe round it takes a fresh
  // answer to land.
  describe("Sway's own measured effort levels on a stale cache", () => {
    const sonnet = (): CatalogModel => ({
      ...model("sonnet", "claude-sonnet-5"),
      supportsEffort: true,
      supportedEffortLevels: ["low", "max"],
      effortLevels: [
        { level: "low", label: "low", disabled: false, note: "" },
        { level: "max", label: "max", disabled: false, note: "" },
        { level: "ultracode", label: "Ultracode", disabled: false, note: "" },
      ],
    });

    beforeEach(() => {
      invoked.mockReset();
      __resetModelCatalogsForTests();
    });

    const levelsAfterProbe = async (installed: string) => {
      invoked.mockImplementation(async (cmd: string) => {
        if (cmd === "refresh_agent_health") return [{ id: "claude", version: installed }];
        if (cmd === "model_catalogs") {
          return [{ ...withModels([sonnet()], "2.1.237"), agentId: "claude" }];
        }
        return [];
      });
      await refreshAgentHealth();
      await ensureModelCatalogsLoaded();
      return cachedModels(catalogFor("claude"))[0].effortLevels?.map((l) => l.level);
    };

    it("keeps them while the binary is the one they were measured against", async () => {
      expect(await levelsAfterProbe("2.1.237")).toEqual(["low", "max", "ultracode"]);
    });

    // Told apart by `supportedEffortLevels` rather than by re-running the
    // version comparison: a level the agent published is in that list and one
    // Sway measured is not.
    it("takes them off once the binary has changed under the cache", async () => {
      expect(await levelsAfterProbe("2.1.240")).toEqual(["low", "max"]);
    });
  });
});

// The store is what a chat picker reads before its session exists, and what
// decides whether opening one costs a process. Both halves matter: the cache is
// free and a probe is not, which is why they are separate commands at all.
describe("the shared store", () => {
  const opencode = (): ModelCatalog => ({
    agentId: "opencode",
    state: "probed",
    catalogue: {
      version: "1.18.3",
      probedAtMs: 0,
      models: [model("anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-4.6")],
      modes: [],
      account: null,
    },
    lastFailure: null,
  });
  const unasked = (): ModelCatalog => ({
    agentId: "claude",
    state: "neverProbed",
    catalogue: null,
    lastFailure: null,
  });

  beforeEach(() => {
    invoked.mockReset();
    __resetModelCatalogsForTests();
    invoked.mockImplementation(async (cmd: string) => {
      if (cmd === "model_catalogs") return [opencode(), unasked()];
      if (cmd === "refresh_model_catalog") return opencode();
      return [];
    });
  });

  it("hands each agent its own remembered answer and nobody else's", async () => {
    await ensureModelCatalogsLoaded();
    expect(cachedModels(catalogFor("opencode")).map((m) => m.value)).toEqual([
      "anthropic/claude-sonnet-4.6",
    ]);
    // The row an unasked agent gets is an empty list, which `pickableModels`
    // reads as "no models" rather than as a list worth offering.
    expect(cachedModels(catalogFor("claude"))).toEqual([]);
    expect(cachedModels(catalogFor("nothing-here"))).toEqual([]);
  });

  it("reads the cache without probing anything", async () => {
    await ensureModelCatalogsLoaded();
    expect(invoked.mock.calls.map(([cmd]) => cmd)).toEqual(["model_catalogs"]);
  });

  // Opening a chat is already launching that agent, so asking it costs nothing
  // new. Asking one that answered about the binary now installed would.
  it("asks a agent nobody has asked, and leaves a current answer alone", async () => {
    await refreshCatalogIfDue("claude");
    expect(invoked.mock.calls.filter(([cmd]) => cmd === "refresh_model_catalog")).toHaveLength(1);

    await refreshCatalogIfDue("opencode");
    expect(invoked.mock.calls.filter(([cmd]) => cmd === "refresh_model_catalog")).toHaveLength(1);
  });

  // The point of stamping the shape at all: the binary is unchanged, so nothing
  // a version comparison can see has moved, and the answer still has to be
  // re-asked because this Sway reads a field that cache does not carry.
  it("re-asks a agent whose cache is the right binary in the wrong shape", async () => {
    invoked.mockImplementation(async (cmd: string) => {
      if (cmd === "model_catalogs") {
        const old = opencode();
        return [{ ...old, catalogue: { ...old.catalogue!, shape: CACHE_SHAPE - 1 } }];
      }
      if (cmd === "refresh_agent_health") return [{ id: "opencode", version: "1.18.3" }];
      if (cmd === "refresh_model_catalog") return opencode();
      return [];
    });
    await refreshAgentHealth();
    await refreshCatalogIfDue("opencode");
    expect(invoked.mock.calls.filter(([cmd]) => cmd === "refresh_model_catalog")).toHaveLength(1);
  });
});

// Two agents, two sources, and the bug was that one shadowed the other:
// claude's levers are a function of the model and live on the row, an ACP
// agent's are a function of the session and live on the catalogue.
describe("the levers a draft can read before it has a session", () => {
  const acp = (): ModelCatalog => ({
    agentId: "codex",
    state: "probed",
    catalogue: {
      version: "1.2.0",
      probedAtMs: 0,
      // Empty **by design**, not by omission: `acp_catalogue` writes
      // `options: Vec::new()` on every row because the set belongs to the
      // session. `??` stopped here and handed back nothing.
      models: [{ ...model("gpt-5", "gpt-5"), options: [] }],
      modes: [],
      options: [
        {
          id: "collaboration_mode",
          name: "Collaboration mode",
          description: "",
          category: "",
          disabled: false,
          note: "",
          kind: "select",
          current: "default",
          choices: [{ value: "default", label: "Default", description: "" }],
        },
      ],
      account: null,
    },
    lastFailure: null,
  });

  it("falls through an ACP row's empty list to the session's own set", () => {
    expect(cachedOptions(acp(), "gpt-5").map((o) => o.id)).toEqual(["collaboration_mode"]);
  });

  it("still lets a row that carries its own answer win", () => {
    const claude = withModels([
      {
        ...model("haiku", "claude-haiku-4-5"),
        options: [
          { id: "fast_mode", name: "Fast mode", description: "", category: "", disabled: true, note: "", kind: "boolean", value: false },
        ],
      },
    ]);
    expect(cachedOptions(claude, "haiku").map((o) => o.id)).toEqual(["fast_mode"]);
  });

  it("answers nothing for a agent nobody has probed", () => {
    expect(cachedOptions(undefined, "gpt-5")).toEqual([]);
  });
});
