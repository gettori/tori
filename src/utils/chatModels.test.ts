import { describe, it, expect, vi } from "vitest";
import {
  cachedModes,
  capabilitiesFor,
  contextPercent,
  contextTokens,
  contextWindowFor,
  defaultMode,
  modeAfterModelSwitch,
  pickLanded,
  pickableModels,
  pickableModes,
  reportedWindows,
  restoredPicks,
  selectedModel,
} from "./chatModels";
import type { ChatConfig, ChatMode } from "./agents";
import type { CatalogModel, ModelCatalog } from "./modelCatalog";
import type { ChatModeInfo, ChatModelInfo } from "./chatTypes";

// The shape of the real thing, trimmed to what these functions read. Written by
// hand rather than cast from a partial: a cast checks nothing, which is the
// lesson a fixture on this project already taught once.
function adapter(): ChatConfig {
  return {
    transport: "claude_stream_json",
    program: "claude",
    base_args: [],
    session_id_args: [],
    resume_args: [],
    model_args: ["--model", "{model}"],
    effort_args: ["--effort", "{effort}"],
    mode_args: ["--permission-mode", "{mode}"],
    add_dir_args: [],
    modes: [],
    effort_extras: [],
    acp: { serve_client_fs: false },
  };
}

// What `catalog_probe` cached the last time it asked this agent. Same shape as
// a live row, which is the point: a picker reads one where it reads the other.
function cached(): CatalogModel[] {
  return [
    {
      value: "sonnet",
      resolvedModel: "claude-sonnet-5",
      displayName: "Sonnet",
      description: "Sonnet 5",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
      supportsAutoMode: true,
      supportsFastMode: false,
      supportsAdaptiveThinking: false,
    },
    {
      value: "claude-opus-5-20260101",
      resolvedModel: "",
      displayName: "claude-opus-5-20260101",
      description: "Configured in settings.json `env.ANTHROPIC_MODEL`",
      supportsEffort: false,
      supportedEffortLevels: [],
      supportsAutoMode: false,
      supportsFastMode: false,
      supportsAdaptiveThinking: false,
      userConfigured: true,
    },
  ];
}

// The measured catalogue: `default` and `sonnet` resolve to one id, and haiku
// declares no effort at all.
function live(): ChatModelInfo[] {
  return [
    {
      value: "default",
      resolvedModel: "claude-sonnet-5",
      displayName: "Default (recommended)",
      description: "Sonnet 5",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAutoMode: true,
      supportsFastMode: false,
      supportsAdaptiveThinking: false,
    },
    {
      value: "sonnet",
      resolvedModel: "claude-sonnet-5",
      displayName: "Sonnet",
      description: "Sonnet 5",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAutoMode: true,
      supportsFastMode: false,
      supportsAdaptiveThinking: false,
    },
    {
      value: "haiku",
      resolvedModel: "claude-haiku-4-5-20251001",
      displayName: "Haiku",
      description: "Fastest",
      supportsEffort: false,
      supportedEffortLevels: [],
      supportsAutoMode: false,
      supportsFastMode: false,
      supportsAdaptiveThinking: false,
    },
  ];
}

describe("pickableModels", () => {
  it("prefers the live catalogue and keeps both ids apart", () => {
    const models = pickableModels(live(), []);
    expect(models.map((m) => m.value)).toEqual(["default", "sonnet", "haiku"]);
    expect(models[0].resolvedModel).toBe("claude-sonnet-5");
    expect(models[0].label).toBe("Default (recommended)");
    expect(models.every((m) => m.live)).toBe(true);
  });

  // The adapter used to declare a window per model, which is what a fresh
  // session's meter divided by. It is gone, and nothing replaces it before the
  // first turn: `reported` is empty until one completes.
  it("reports no context window before a turn has measured one", () => {
    const models = pickableModels(live(), []);
    expect(models.every((m) => m.contextWindow === null)).toBe(true);
  });

  it("takes the window from the running session once a turn has reported one", () => {
    const models = pickableModels(live(), [], { "claude-sonnet-5": 1_000_000 });
    expect(models.find((m) => m.value === "sonnet")?.contextWindow).toBe(1_000_000);
    // Nothing reported for haiku, so nothing is shown for haiku.
    expect(models.find((m) => m.value === "haiku")?.contextWindow).toBeNull();
  });

  it("falls back to the cache when the handshake did not happen", () => {
    const models = pickableModels([], cached());
    expect(models.map((m) => m.value)).toEqual(["sonnet", "claude-opus-5-20260101"]);
    expect(models.every((m) => m.live)).toBe(false);
  });

  // The rule the whole phase exists for: a hand-maintained table used to answer
  // here with four models the installed CLI was never asked about.
  it("offers nothing when neither the session nor the cache has an answer", () => {
    expect(pickableModels([], [])).toEqual([]);
    expect(pickableModels([], [])).toEqual([]);
  });

  it("does not merge the cache into a live catalogue", () => {
    // The cache holds two rows and the live catalogue three. A merge would offer
    // `sonnet` twice and re-offer a configured id this CLI may no longer take.
    const models = pickableModels(live(), cached());
    expect(models).toHaveLength(3);
    expect(models.map((m) => m.value)).not.toContain("claude-opus-5-20260101");
  });

  // A configured row cannot claim a resolution, so it carries an empty one and
  // says where it came from. Anything deduping by `resolvedModel` has to notice.
  it("marks a row the user configured rather than mixing it in", () => {
    const models = pickableModels([], cached());
    const configured = models.find((m) => m.value === "claude-opus-5-20260101");
    expect(configured?.userConfigured).toBe(true);
    expect(configured?.resolvedModel).toBe("");
    expect(models.find((m) => m.value === "sonnet")?.userConfigured).toBe(false);
  });

  // Fast mode comes off the row the agent published, not off an adapter table.
  // Sway used to keep one, keyed on `claude-opus-5` while the catalogue resolves
  // both Opus rows to `claude-opus-5[1m]`, so the lookup matched nothing.
  it("carries fast mode from the row that declares it and no further", () => {
    const models = live();
    models[1].supportsFastMode = true;
    expect(
      pickableModels(models, [])
        .filter((m) => m.fastMode)
        .map((m) => m.value),
    ).toEqual(["sonnet"]);
  });

  it("claims no fast mode for a catalogue where nothing declares one", () => {
    expect(pickableModels(live(), []).some((m) => m.fastMode)).toBe(false);
  });

  // **The synthesis is the backend's**, in `claude::effort_levels`, where the
  // probed CLI version is known and a measured extra can be scoped to it.
  // What is pinned here is that the three answers it can send arrive intact.
  describe("effort rows", () => {
    const sonnetRows = (rows: ChatModelInfo["effortLevels"]) => {
      const models = live();
      models[1].effortLevels = rows;
      return pickableModels(models, []).find((m) => m.value === "sonnet")!.effortLevels;
    };

    it("offers exactly the levels the agent published when nothing was measured", () => {
      const rows = sonnetRows([
        { level: "low", label: "low", disabled: false, note: "" },
        { level: "max", label: "max", disabled: false, note: "" },
      ]);
      expect(rows.map((l) => l.level)).toEqual(["low", "max"]);
      expect(rows.every((l) => !l.disabled)).toBe(true);
    });

    it("carries a measured extra through as a level of its own", () => {
      const rows = sonnetRows([
        { level: "low", label: "low", disabled: false, note: "" },
        { level: "ultracode", label: "Ultracode", disabled: false, note: "" },
      ]);
      expect(rows.map((l) => l.level)).toEqual(["low", "ultracode"]);
      expect(rows[1].label).toBe("Ultracode");
    });

    it("carries a refused extra through with its reason rather than dropping it", () => {
      const rows = sonnetRows([
        { level: "low", label: "low", disabled: false, note: "" },
        { level: "ultracode", label: "Ultracode", disabled: true, note: "Measured on 2.1.237." },
      ]);
      expect(rows[1]).toMatchObject({ disabled: true, note: "Measured on 2.1.237." });
    });

    // A catalogue cached before the field existed is not a model with no
    // levels, it is one nobody re-probed. What it recorded is the published
    // list with nothing measured on top, which is what it falls back to.
    it("falls back to the published list for a catalogue cached before the field existed", () => {
      const models = live();
      delete models[1].effortLevels;
      const rows = pickableModels(models, []).find((m) => m.value === "sonnet")!.effortLevels;
      expect(rows.map((l) => l.level)).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(rows.every((l) => !l.disabled)).toBe(true);
    });
  });

  it("hides effort for a model that declares none", () => {
    const models = pickableModels(live(), []);
    expect(models.find((m) => m.value === "haiku")?.effortLevels).toEqual([]);
    expect(models.find((m) => m.value === "sonnet")?.effortLevels.map((l) => l.level)).toContain("xhigh");
  });
});

describe("selectedModel", () => {
  it("prefers the value that was picked over the id init reports", () => {
    const models = pickableModels(live(), []);
    // Both resolve to claude-sonnet-5; only the picked value says which.
    expect(selectedModel(models, "sonnet", "claude-sonnet-5")?.value).toBe("sonnet");
    expect(selectedModel(models, "default", "claude-sonnet-5")?.value).toBe("default");
  });

  it("falls back to the resolved id when nothing has been picked yet", () => {
    const models = pickableModels(live(), []);
    expect(selectedModel(models, null, "claude-haiku-4-5-20251001")?.value).toBe("haiku");
  });

  it("names the model rather than the alias when several values share a resolution", () => {
    const models = pickableModels(live(), []);
    // `default` is listed first and resolves to the same id as `sonnet`. Taking
    // the first match showed "Default (recommended)" on a fresh session while
    // every other readout named the real model.
    expect(selectedModel(models, null, "claude-sonnet-5")?.value).toBe("sonnet");
    // An entry whose value *is* the resolved id wins outright.
    const withExact = pickableModels(
      [
        ...live(),
        {
          value: "claude-sonnet-5",
          resolvedModel: "claude-sonnet-5",
          displayName: "Sonnet 5",
          description: "",
          supportsEffort: false,
          supportedEffortLevels: [],
          supportsAutoMode: false,
          supportsFastMode: false,
          supportsAdaptiveThinking: false,
        },
      ], [],
    );
    expect(selectedModel(withExact, null, "claude-sonnet-5")?.value).toBe("claude-sonnet-5");
    // An explicit pick still wins over both, including picking the alias.
    expect(selectedModel(models, "default", "claude-sonnet-5")?.value).toBe("default");
  });

  it("ignores a picked value the catalogue no longer offers", () => {
    const models = pickableModels(live(), []);
    // Falls back to the resolution, and names the model rather than the alias.
    expect(selectedModel(models, "gone", "claude-sonnet-5")?.value).toBe("sonnet");
    expect(selectedModel(models, "gone", null)).toBeNull();
  });
});

describe("pickLanded", () => {
  it("confirms through resolvedModel, never through the picked value", () => {
    const models = pickableModels(live(), []);
    expect(pickLanded(models, "haiku", "claude-haiku-4-5-20251001")).toBe(true);
    // The trap: init never reports "haiku", so comparing the value would say
    // the switch failed on every successful switch.
    expect(pickLanded(models, "haiku", "haiku")).toBe(false);
  });

  it("does not confirm a pick the session has not moved to", () => {
    const models = pickableModels(live(), []);
    expect(pickLanded(models, "haiku", "claude-sonnet-5")).toBe(false);
  });

  it("refuses to confirm a value the catalogue does not know", () => {
    const models = pickableModels(live(), []);
    expect(pickLanded(models, "gone", "claude-sonnet-5")).toBe(false);
  });
});

describe("restoredPicks", () => {
  it("restores a combination the catalogue still offers", () => {
    const models = pickableModels(live(), []);
    expect(restoredPicks(models, { model: "sonnet", effort: "xhigh" })).toEqual({
      model: expect.objectContaining({ value: "sonnet" }),
      effort: "xhigh",
      mode: null,
    });
  });

  it("drops a model the catalogue no longer offers, keeping the session's own", () => {
    const models = pickableModels(live(), []);
    // Re-sending it would open every session with an error, and the picker
    // still has the session's resolved model to show.
    expect(restoredPicks(models, { model: "opus-3", effort: "high" })).toEqual({
      model: null,
      effort: null,
      mode: null,
    });
  });

  it("drops an effort level the restored model does not offer", () => {
    const models = pickableModels(live(), []);
    expect(restoredPicks(models, { model: "haiku", effort: "max" }).effort).toBeNull();
  });

  it("restores nothing from an empty preference", () => {
    expect(restoredPicks(pickableModels(live(), []), {})).toEqual({
      model: null,
      effort: null,
      mode: null,
    });
  });

  it("restores a mode the adapter still declares", () => {
    const chat = adapter();
    chat.modes = [{ id: "plan", label: "Plan", hint: "", args: [] }];
    const models = pickableModels(live(), []);
    expect(restoredPicks(models, { model: "sonnet", mode: "plan" }, chat).mode).toBe("plan");
  });

  // The case a settings file produces once modes come from the adapter rather
  // than from four hardcoded strings: a project pinned to a Claude mode, opened
  // against a agent whose modes are Gemini's. The stored mode is dropped and
  // the session still starts.
  it("drops a mode the adapter does not declare", () => {
    const chat = adapter();
    chat.modes = [
      { id: "auto_edit", label: "Auto edit", hint: "", args: [], default: true },
      { id: "yolo", label: "Yolo", hint: "", args: [] },
    ];
    const models = pickableModels(live(), []);
    expect(restoredPicks(models, { model: "sonnet", mode: "bypassPermissions" }, chat).mode).toBeNull();
  });

  // The read-back half of the missing `live` argument. Every ACP adapter
  // declares an empty `[[chat.modes]]` on purpose, so checking a remembered
  // mode against the table alone throws away every mode those agents have.
  it("restores a mode the agent published even though its adapter declares none", () => {
    const chat = adapter();
    chat.modes = [];
    const agentModes = pickableModes([{ id: "plan", label: "Plan", hint: "" }], chat);
    const models = pickableModels(live(), []);
    expect(restoredPicks(models, { model: "sonnet", mode: "plan" }, chat, agentModes).mode).toBe(
      "plan",
    );
    // And the drop still happens for a mode nothing on offer names, which is
    // what keeps this a check rather than a passthrough.
    expect(
      restoredPicks(models, { model: "sonnet", mode: "read-only" }, chat, agentModes).mode,
    ).toBeNull();
  });
});

describe("pickableModes", () => {
  // The three `@agentclientprotocol/codex-acp` 1.2.0 publishes, measured.
  const liveModes = (): ChatModeInfo[] => [
    { id: "read-only", label: "Read Only", hint: "Ask before writing" },
    { id: "agent", label: "Agent", hint: "" },
    { id: "agent-full-access", label: "Agent (full access)", hint: "" },
  ];

  it("takes the agent's own modes over the adapter table", () => {
    const chat = adapter();
    chat.modes = [{ id: "plan", label: "Plan", hint: "", args: [] }];
    expect(pickableModes(liveModes(), chat).map((m) => m.id)).toEqual([
      "read-only",
      "agent",
      "agent-full-access",
    ]);
  });

  // Not a merge, on the same rule as `pickableModels`: folding the TOML in
  // would offer a mode this agent does not have.
  it("falls back to the adapter table only when the agent published none", () => {
    const chat = adapter();
    chat.modes = [{ id: "plan", label: "Plan", hint: "", args: [] }];
    expect(pickableModes([], chat).map((m) => m.id)).toEqual(["plan"]);
  });

  // An ACP mode is a request, not a flag, and nothing on the wire says which of
  // an agent's modes runs tools unattended. Both absences are deliberate: a
  // guessed `permissive` would put a caution on the wrong row or leave it off
  // the right one.
  it("declares no args and does not guess which mode is permissive", () => {
    const modes = pickableModes(liveModes(), null);
    expect(modes.every((m) => m.args.length === 0)).toBe(true);
    expect(modes.every((m) => m.permissive === undefined)).toBe(true);
    expect(modes.every((m) => m.default === undefined)).toBe(true);
  });

  it("falls back to the mode's id when the agent gave it no label", () => {
    const modes = pickableModes([{ id: "read-only", label: "", hint: "" }], null);
    expect(modes[0].label).toBe("read-only");
  });

  // The whole reason this exists: an ACP adapter declares no `[[chat.modes]]`,
  // so without the live list the selector has nothing to show and a Codex user
  // cannot reach the one mode that makes the agent ask before it writes.
  it("gives an ACP session a selector its adapter could not", () => {
    const chat = adapter();
    chat.modes = [];
    expect(capabilitiesFor(null, chat).modes).toEqual([]);
    expect(capabilitiesFor(null, chat, pickableModes(liveModes(), chat)).modes).toHaveLength(3);
  });

  // The current mode is one the agent published, so a model switch has no
  // reason to move it. Without the live list `allowed` is the adapter's empty
  // table and this only returned null by accident.
  it("does not move a live mode on a model switch", () => {
    const chat = adapter();
    chat.modes = [];
    const model = pickableModels(live(), [])[0];
    expect(modeAfterModelSwitch(model, chat, "read-only", pickableModes(liveModes(), chat))).toBe(
      null,
    );
  });
});

// What a draft can say about modes with no session to ask. The two agents
// answer from different halves of the cache, which is exactly why one function
// has to own the question.
describe("cachedModes", () => {
  const probed = (modes: ChatModeInfo[], current: string | null): ModelCatalog => ({
    agentId: "codex",
    state: "probed",
    catalogue: {
      version: "1.2.0",
      probedAtMs: 0,
      models: [],
      modes,
      options:
        current === null
          ? []
          : [
              {
                // Found by category, never by this id: `acp.rs` matches that
                // way because `category` is the spec's word for what an option
                // is, and an agent's ids are its own vocabulary.
                id: "collaboration_mode",
                name: "Mode",
                description: "",
                category: "mode",
                disabled: false,
                note: "",
                kind: "select",
                current,
                choices: modes.map((m) => ({ value: m.id, label: m.label, description: "" })),
              },
            ],
      account: null,
    },
    lastFailure: null,
  });

  // The three `@agentclientprotocol/codex-acp` 1.2.0 publishes, cached from a
  // probe rather than from a session.
  const codexModes = (): ChatModeInfo[] => [
    { id: "read-only", label: "Read Only", hint: "Ask before writing" },
    { id: "agent", label: "Agent", hint: "" },
    { id: "agent-full-access", label: "Agent (full access)", hint: "" },
  ];

  it("gives an ACP agent its own rows and the mode its session opened in", () => {
    const chat = adapter();
    chat.modes = [];
    const answer = cachedModes(probed(codexModes(), "agent"), chat);
    expect(answer.modes.map((m) => m.id)).toEqual(["read-only", "agent", "agent-full-access"]);
    expect(answer.current).toBe("agent");
  });

  // Claude publishes neither: no modes on the wire and no options at all, so
  // both halves come off the adapter and `defaultMode` is what names the one a
  // session would open in.
  it("gives a declared-mode agent the adapter's rows and its declared default", () => {
    const chat = adapter();
    chat.modes = [
      { id: "default", label: "Ask", hint: "", args: [], default: true },
      { id: "plan", label: "Plan", hint: "", args: [] },
    ];
    const answer = cachedModes(probed([], null), chat);
    expect(answer.modes.map((m) => m.id)).toEqual(["default", "plan"]);
    expect(answer.current).toBe("default");
  });

  // Nothing cached and nothing declared is an answer, not a gap: the draft
  // renders no selector rather than an empty menu.
  it("answers nothing at all for an unprobed agent that declares no modes", () => {
    const chat = adapter();
    chat.modes = [];
    expect(cachedModes(undefined, chat)).toEqual({ modes: [], current: null });
  });
});

describe("capabilitiesFor", () => {
  // Haiku declares none of the per-model capability flags, which is what makes
  // the intersection load-bearing rather than a passthrough of the adapter.
  it("offers nothing model-scoped for a model that declares nothing", () => {
    const chat = adapter();
    chat.modes = [{ id: "plan", label: "Plan", hint: "", args: [] }];
    const models = pickableModels(live(), []);
    const haiku = models.find((m) => m.value === "haiku")!;

    // Effort is the model's own, read off its rows rather than restated here.
    expect(haiku.effortLevels).toEqual([]);

    const caps = capabilitiesFor(haiku, chat);
    expect(caps.fastMode).toBe(false);
    // Modes are a property of the agent, not of the model, so they survive.
    expect(caps.modes.map((m) => m.id)).toEqual(["plan"]);
  });

  it("offers everything for a model that declares everything", () => {
    const chat = adapter();
    chat.modes = [{ id: "plan", label: "Plan", hint: "", args: [] }];
    const rows = live();
    // Declared on the row rather than annotated from the adapter, which is
    // where this fact lives now.
    rows[1].supportsFastMode = true;
    const models = pickableModels(rows, []);
    const sonnet = models.find((m) => m.value === "sonnet")!;

    // Effort is not among them: the control reads the model's own rows, which
    // is the one place a level can be offered or refused.
    expect(sonnet.effortLevels.map((l) => l.level)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(sonnet.effortLevels.every((l) => !l.disabled)).toBe(true);

    const caps = capabilitiesFor(sonnet, chat);
    expect(caps.fastMode).toBe(true);
    expect(caps.modes.map((m) => m.id)).toEqual(["plan"]);
  });

  it("offers nothing model-scoped before a model is known", () => {
    const chat = adapter();
    chat.modes = [{ id: "plan", label: "Plan", hint: "", args: [] }];
    const caps = capabilitiesFor(null, chat);
    expect(caps.fastMode).toBe(false);
    expect(caps.modes.map((m) => m.id)).toEqual(["plan"]);
  });
});

describe("modeAfterModelSwitch", () => {
  const GATED: ChatMode[] = [
    { id: "default", label: "Ask", hint: "", args: [], default: true },
    { id: "auto", label: "Auto", hint: "", args: [], requires: "supportsAutoMode" },
  ];

  function gatedAdapter(): ChatConfig {
    const chat = adapter();
    chat.modes = GATED;
    return chat;
  }

  // The hole this closes: the row is hidden for a model without the capability,
  // but hiding it does nothing about a mode already in force. Measured on
  // claude 2.1.220, a session asking for `auto` on such a model exits 0 and
  // runs `default`, so nothing downstream would report the disagreement.
  it("drops a gated mode when moving to a model that cannot honour it", () => {
    const chat = gatedAdapter();
    const haiku = pickableModels(live(), []).find((m) => m.value === "haiku")!;
    expect(modeAfterModelSwitch(haiku, chat, "auto")).toBe("default");
  });

  it("keeps the mode when the new model can honour it", () => {
    const chat = gatedAdapter();
    const sonnet = pickableModels(live(), []).find((m) => m.value === "sonnet")!;
    expect(modeAfterModelSwitch(sonnet, chat, "auto")).toBeNull();
  });

  it("leaves an ungated mode alone whatever the model", () => {
    const chat = gatedAdapter();
    const haiku = pickableModels(live(), []).find((m) => m.value === "haiku")!;
    expect(modeAfterModelSwitch(haiku, chat, "default")).toBeNull();
  });

  it("has nothing to say when no mode is in force", () => {
    expect(modeAfterModelSwitch(null, gatedAdapter(), null)).toBeNull();
  });

  // A gated default would send us straight back here on the next switch.
  it("falls back within what is still offered, not to a gated default", () => {
    const chat = adapter();
    chat.modes = [
      { id: "auto", label: "Auto", hint: "", args: [], default: true, requires: "supportsAutoMode" },
      { id: "plan", label: "Plan", hint: "", args: [] },
    ];
    const haiku = pickableModels(live(), []).find((m) => m.value === "haiku")!;
    expect(modeAfterModelSwitch(haiku, chat, "auto")).toBe("plan");
  });
});

describe("defaultMode", () => {
  // The fallback must never be the literal "default": that is Claude's spelling
  // of the idea, and a resolver carrying it picks nothing at all on a agent
  // whose modes are named otherwise.
  it("is the mode the adapter marks, whatever it is called", () => {
    const chat = adapter();
    chat.modes = [
      { id: "yolo", label: "Yolo", hint: "", args: [] },
      { id: "auto_edit", label: "Auto edit", hint: "", args: [], default: true },
    ];
    expect(defaultMode(chat)?.id).toBe("auto_edit");
  });

  it("falls back to the first declared mode, not to a name", () => {
    const chat = adapter();
    chat.modes = [
      { id: "yolo", label: "Yolo", hint: "", args: [] },
      { id: "auto_edit", label: "Auto edit", hint: "", args: [] },
    ];
    expect(defaultMode(chat)?.id).toBe("yolo");
  });

  it("has no answer for an adapter declaring no modes", () => {
    expect(defaultMode(adapter())).toBeNull();
  });
});

describe("contextTokens", () => {
  const usage = (over: Partial<Parameters<typeof contextTokens>[0] & object> = {}) => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    ...over,
  });

  it("counts everything the model was given, and not what it produced", () => {
    // Output is left out because it becomes input on the next turn; counting it
    // here would count it twice.
    expect(contextTokens(usage({ inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 900 }))).toBe(
      125,
    );
  });

  it("is null before any turn reported usage, so the meter stays hidden", () => {
    expect(contextTokens(null)).toBeNull();
  });

  it("tracks the running total because each turn's input carries the history", () => {
    // Two turns of a real conversation: the second turn's input contains the
    // first. Replacing rather than summing is what makes the figure track the
    // conversation instead of racing ahead of it.
    const turnOne = contextTokens(usage({ inputTokens: 1000, outputTokens: 200 }))!;
    const turnTwo = contextTokens(usage({ inputTokens: 1400, outputTokens: 300 }))!;
    expect(turnTwo).toBeGreaterThan(turnOne);
    expect(turnTwo).toBe(1400);
  });
});

describe("contextWindowFor", () => {
  // **The accepted cost of the phase.** A Claude session has no denominator
  // until its first turn completes. What used to sit here was the adapter's
  // declared figure, and it was measurably wrong: 200k written down for models
  // the agent runs at 1M. Showing nothing beats showing that.
  it("is null before a turn has measured one, so the meter stays hidden", () => {
    expect(contextWindowFor("claude-sonnet-5")).toBeNull();
    expect(contextWindowFor("claude-opus-5", {})).toBeNull();
  });

  it("takes the window the session reported once one exists", () => {
    expect(contextWindowFor("claude-sonnet-5", { "claude-sonnet-5": 1_000_000 })).toBe(1_000_000);
  });

  it("reports nothing for a model no source knows, rather than a guessed window", () => {
    expect(contextWindowFor("some-model-nobody-declared", {})).toBeNull();
  });

  // ACP agents report occupancy and window together, for the session rather
  // than per model, so an agent Sway drives over ACP has a denominator from its
  // first usage update - and it is the agent's own, not a catalogue's.
  it("takes the window a session states for itself when no model figure exists", () => {
    expect(contextWindowFor("some-acp-model", {}, 272_000)).toBe(272_000);
  });

  // Per model beats per session: the finer measurement wins where both exist,
  // because a session can run more than one model.
  it("prefers the model's own reported window to the session's", () => {
    expect(contextWindowFor("claude-sonnet-5", { "claude-sonnet-5": 1_000_000 }, 200_000)).toBe(1_000_000);
  });
});

describe("reportedWindows", () => {
  // The exact shape measured on `result.modelUsage`.
  const usage = {
    modelUsage: {
      "claude-haiku-4-5-20251001": { contextWindow: 200000, canonicalModel: "claude-haiku-4-5" },
      "claude-sonnet-5": { contextWindow: 1_000_000, canonicalModel: "claude-sonnet-5" },
    },
  };

  it("reads the window the agent reported for each model", () => {
    expect(reportedWindows(usage)["claude-sonnet-5"]).toBe(1_000_000);
  });

  // The dated key and the canonical id are different strings, and `system/init`
  // may report back either, so a lookup has to succeed under both.
  it("keys a window under the canonical id as well as the dated one", () => {
    const w = reportedWindows(usage);
    expect(w["claude-haiku-4-5-20251001"]).toBe(200000);
    expect(w["claude-haiku-4-5"]).toBe(200000);
  });

  it("is empty for a turn that reported no usage at all", () => {
    expect(reportedWindows(undefined)).toEqual({});
    expect(reportedWindows({})).toEqual({});
  });

  // A malformed or zero window is not a window. Taking it would put a zero
  // denominator behind a percentage.
  it("ignores an entry with no usable window", () => {
    expect(reportedWindows({ modelUsage: { a: { contextWindow: 0 }, b: { contextWindow: "big" }, c: null } })).toEqual(
      {},
    );
  });
});

describe("contextPercent", () => {
  it("is the share of the window in use", () => {
    expect(contextPercent(50_000, 200_000)).toBe(25);
  });

  it("is null when either number is missing, so no meter renders", () => {
    expect(contextPercent(null, 200_000)).toBeNull();
    expect(contextPercent(50_000, null)).toBeNull();
  });

  // The symptom that started this: a meter reading 187%. Usage above the window
  // is a contradiction, so the resolver reports "unknown" rather than clamping
  // to a full bar, which would read as a session about to compact.
  it("reports nothing when usage exceeds the window, rather than clamping to 100", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(contextPercent(374_000, 200_000)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exceeds the resolved window"));
    warn.mockRestore();
  });
});
