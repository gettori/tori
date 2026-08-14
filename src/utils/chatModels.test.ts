import { describe, it, expect, vi } from "vitest";
import {
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
    models: [
      {
        id: "claude-sonnet-5",
        label: "Sonnet 5",
        context_window: 200000,
        effort_levels: ["low", "high"],
        supports_thinking: true,
        supports_images: true,
      },
      {
        id: "claude-haiku-4-5-20251001",
        label: "Haiku 4.5",
        context_window: null,
        effort_levels: [],
        supports_thinking: false,
        supports_images: true,
      },
    ],
    modes: [],
    effort: [],
    acp: { serve_client_fs: false },
  };
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
    },
    {
      value: "sonnet",
      resolvedModel: "claude-sonnet-5",
      displayName: "Sonnet",
      description: "Sonnet 5",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAutoMode: true,
    },
    {
      value: "haiku",
      resolvedModel: "claude-haiku-4-5-20251001",
      displayName: "Haiku",
      description: "Fastest",
      supportsEffort: false,
      supportedEffortLevels: [],
      supportsAutoMode: false,
    },
  ];
}

describe("pickableModels", () => {
  it("prefers the live catalogue and keeps both ids apart", () => {
    const models = pickableModels(live(), adapter());
    expect(models.map((m) => m.value)).toEqual(["default", "sonnet", "haiku"]);
    expect(models[0].resolvedModel).toBe("claude-sonnet-5");
    expect(models[0].label).toBe("Default (recommended)");
    expect(models.every((m) => m.live)).toBe(true);
  });

  it("takes the context window from the adapter, the only thing that declares one", () => {
    const models = pickableModels(live(), adapter());
    expect(models.find((m) => m.value === "sonnet")?.contextWindow).toBe(200000);
    // Declared null in the table: the meter renders nothing rather than a
    // denominator it made up.
    expect(models.find((m) => m.value === "haiku")?.contextWindow).toBeNull();
  });

  it("falls back to the adapter table when the handshake did not happen", () => {
    const models = pickableModels([], adapter());
    expect(models.map((m) => m.value)).toEqual(["claude-sonnet-5", "claude-haiku-4-5-20251001"]);
    // The table names models by resolved id, so a pick from it is confirmable
    // the same way a live one is.
    expect(models[0].resolvedModel).toBe("claude-sonnet-5");
    expect(models.every((m) => m.live)).toBe(false);
  });

  it("is empty when neither source has anything, rather than inventing a model", () => {
    expect(pickableModels([], null)).toEqual([]);
  });

  it("does not merge the table into a live catalogue", () => {
    // The table lists haiku by its dated id; the live catalogue lists it as
    // `haiku`. A merge would offer both and one of them would be a duplicate.
    const models = pickableModels(live(), adapter());
    expect(models).toHaveLength(3);
  });

  it("hides effort for a model that declares none", () => {
    const models = pickableModels(live(), adapter());
    expect(models.find((m) => m.value === "haiku")?.effortLevels).toEqual([]);
    expect(models.find((m) => m.value === "sonnet")?.effortLevels).toContain("xhigh");
  });
});

describe("selectedModel", () => {
  it("prefers the value that was picked over the id init reports", () => {
    const models = pickableModels(live(), adapter());
    // Both resolve to claude-sonnet-5; only the picked value says which.
    expect(selectedModel(models, "sonnet", "claude-sonnet-5")?.value).toBe("sonnet");
    expect(selectedModel(models, "default", "claude-sonnet-5")?.value).toBe("default");
  });

  it("falls back to the resolved id when nothing has been picked yet", () => {
    const models = pickableModels(live(), adapter());
    expect(selectedModel(models, null, "claude-haiku-4-5-20251001")?.value).toBe("haiku");
  });

  it("names the model rather than the alias when several values share a resolution", () => {
    const models = pickableModels(live(), adapter());
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
        },
      ],
      adapter(),
    );
    expect(selectedModel(withExact, null, "claude-sonnet-5")?.value).toBe("claude-sonnet-5");
    // An explicit pick still wins over both, including picking the alias.
    expect(selectedModel(models, "default", "claude-sonnet-5")?.value).toBe("default");
  });

  it("ignores a picked value the catalogue no longer offers", () => {
    const models = pickableModels(live(), adapter());
    // Falls back to the resolution, and names the model rather than the alias.
    expect(selectedModel(models, "gone", "claude-sonnet-5")?.value).toBe("sonnet");
    expect(selectedModel(models, "gone", null)).toBeNull();
  });
});

describe("pickLanded", () => {
  it("confirms through resolvedModel, never through the picked value", () => {
    const models = pickableModels(live(), adapter());
    expect(pickLanded(models, "haiku", "claude-haiku-4-5-20251001")).toBe(true);
    // The trap: init never reports "haiku", so comparing the value would say
    // the switch failed on every successful switch.
    expect(pickLanded(models, "haiku", "haiku")).toBe(false);
  });

  it("does not confirm a pick the session has not moved to", () => {
    const models = pickableModels(live(), adapter());
    expect(pickLanded(models, "haiku", "claude-sonnet-5")).toBe(false);
  });

  it("refuses to confirm a value the catalogue does not know", () => {
    const models = pickableModels(live(), adapter());
    expect(pickLanded(models, "gone", "claude-sonnet-5")).toBe(false);
  });
});

describe("restoredPicks", () => {
  it("restores a combination the catalogue still offers", () => {
    const models = pickableModels(live(), adapter());
    expect(restoredPicks(models, { model: "sonnet", effort: "xhigh" })).toEqual({
      model: expect.objectContaining({ value: "sonnet" }),
      effort: "xhigh",
      mode: null,
    });
  });

  it("drops a model the catalogue no longer offers, keeping the session's own", () => {
    const models = pickableModels(live(), adapter());
    // Re-sending it would open every session with an error, and the picker
    // still has the session's resolved model to show.
    expect(restoredPicks(models, { model: "opus-3", effort: "high" })).toEqual({
      model: null,
      effort: null,
      mode: null,
    });
  });

  it("drops an effort level the restored model does not offer", () => {
    const models = pickableModels(live(), adapter());
    expect(restoredPicks(models, { model: "haiku", effort: "max" }).effort).toBeNull();
  });

  it("restores nothing from an empty preference", () => {
    expect(restoredPicks(pickableModels(live(), adapter()), {})).toEqual({
      model: null,
      effort: null,
      mode: null,
    });
  });

  it("restores a mode the adapter still declares", () => {
    const chat = adapter();
    chat.modes = [{ id: "plan", label: "Plan", hint: "", args: [] }];
    const models = pickableModels(live(), chat);
    expect(restoredPicks(models, { model: "sonnet", mode: "plan" }, chat).mode).toBe("plan");
  });

  // The case a settings file produces once modes come from the adapter rather
  // than from four hardcoded strings: a project pinned to a Claude mode, opened
  // against a harness whose modes are Gemini's. The stored mode is dropped and
  // the session still starts.
  it("drops a mode the adapter does not declare", () => {
    const chat = adapter();
    chat.modes = [
      { id: "auto_edit", label: "Auto edit", hint: "", args: [], default: true },
      { id: "yolo", label: "Yolo", hint: "", args: [] },
    ];
    const models = pickableModels(live(), chat);
    expect(restoredPicks(models, { model: "sonnet", mode: "bypassPermissions" }, chat).mode).toBeNull();
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
    const model = pickableModels(live(), chat)[0];
    expect(modeAfterModelSwitch(model, chat, "read-only", pickableModes(liveModes(), chat))).toBe(
      null,
    );
  });
});

describe("capabilitiesFor", () => {
  // Haiku declares none of the per-model capability flags, which is what makes
  // the intersection load-bearing rather than a passthrough of the adapter.
  it("offers nothing model-scoped for a model that declares nothing", () => {
    const chat = adapter();
    chat.modes = [{ id: "plan", label: "Plan", hint: "", args: [] }];
    const models = pickableModels(live(), chat);
    const haiku = models.find((m) => m.value === "haiku")!;

    const caps = capabilitiesFor(haiku, chat);
    expect(caps.effortLevels).toEqual([]);
    expect(caps.fastMode).toBe(false);
    // Modes are a property of the harness, not of the model, so they survive.
    expect(caps.modes.map((m) => m.id)).toEqual(["plan"]);
  });

  it("offers everything for a model that declares everything", () => {
    const chat = adapter();
    chat.modes = [{ id: "plan", label: "Plan", hint: "", args: [] }];
    chat.models[0].fast_mode = true;
    const models = pickableModels(live(), chat);
    const sonnet = models.find((m) => m.value === "sonnet")!;

    const caps = capabilitiesFor(sonnet, chat);
    expect(caps.effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(caps.fastMode).toBe(true);
    expect(caps.modes.map((m) => m.id)).toEqual(["plan"]);
  });

  it("offers nothing model-scoped before a model is known", () => {
    const chat = adapter();
    chat.modes = [{ id: "plan", label: "Plan", hint: "", args: [] }];
    const caps = capabilitiesFor(null, chat);
    expect(caps.effortLevels).toEqual([]);
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
    const haiku = pickableModels(live(), chat).find((m) => m.value === "haiku")!;
    expect(modeAfterModelSwitch(haiku, chat, "auto")).toBe("default");
  });

  it("keeps the mode when the new model can honour it", () => {
    const chat = gatedAdapter();
    const sonnet = pickableModels(live(), chat).find((m) => m.value === "sonnet")!;
    expect(modeAfterModelSwitch(sonnet, chat, "auto")).toBeNull();
  });

  it("leaves an ungated mode alone whatever the model", () => {
    const chat = gatedAdapter();
    const haiku = pickableModels(live(), chat).find((m) => m.value === "haiku")!;
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
    const haiku = pickableModels(live(), chat).find((m) => m.value === "haiku")!;
    expect(modeAfterModelSwitch(haiku, chat, "auto")).toBe("plan");
  });
});

describe("defaultMode", () => {
  // The fallback must never be the literal "default": that is Claude's spelling
  // of the idea, and a resolver carrying it picks nothing at all on a harness
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
  it("is null without an adapter, so the meter stays hidden", () => {
    expect(contextWindowFor(null, "claude-sonnet-5")).toBeNull();
    expect(contextWindowFor(adapter(), "claude-opus-5")).toBeNull();
    expect(contextWindowFor(adapter(), "claude-sonnet-5")).toBe(200000);
  });

  // The whole point of the order. The adapter figure is hand-maintained and was
  // measurably wrong (200k written down for a model the harness runs at 1M), so
  // the session's own report has to win rather than tie.
  it("prefers what the session reported over what the adapter declares", () => {
    expect(contextWindowFor(adapter(), "claude-sonnet-5", { "claude-sonnet-5": 1_000_000 })).toBe(1_000_000);
  });

  it("falls back to the adapter before any turn has reported one", () => {
    expect(contextWindowFor(adapter(), "claude-sonnet-5", {})).toBe(200000);
  });

  it("reports nothing for a model no source knows, rather than a guessed window", () => {
    expect(contextWindowFor(adapter(), "some-model-nobody-declared", {})).toBeNull();
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

  it("reads the window the harness reported for each model", () => {
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
