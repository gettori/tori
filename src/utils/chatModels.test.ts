import { describe, it, expect } from "vitest";
import {
  capabilitiesFor,
  contextTokens,
  contextWindowFor,
  defaultMode,
  pickLanded,
  pickableModels,
  restoredPicks,
  selectedModel,
} from "./chatModels";
import type { ChatConfig } from "./agents";
import type { ChatModelInfo } from "./chatTypes";

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
    },
    {
      value: "sonnet",
      resolvedModel: "claude-sonnet-5",
      displayName: "Sonnet",
      description: "Sonnet 5",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      value: "haiku",
      resolvedModel: "claude-haiku-4-5-20251001",
      displayName: "Haiku",
      description: "Fastest",
      supportsEffort: false,
      supportedEffortLevels: [],
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
      [...live(), { value: "claude-sonnet-5", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5", description: "", supportsEffort: false, supportedEffortLevels: [] }],
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
    chat.modes = [{ id: "plan", label: "Plan", args: [] }];
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
      { id: "auto_edit", label: "Auto edit", args: [], default: true },
      { id: "yolo", label: "Yolo", args: [] },
    ];
    const models = pickableModels(live(), chat);
    expect(restoredPicks(models, { model: "sonnet", mode: "bypassPermissions" }, chat).mode).toBeNull();
  });
});

describe("capabilitiesFor", () => {
  // Haiku declares none of the per-model capability flags, which is what makes
  // the intersection load-bearing rather than a passthrough of the adapter.
  it("offers nothing model-scoped for a model that declares nothing", () => {
    const chat = adapter();
    chat.modes = [{ id: "plan", label: "Plan", args: [] }];
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
    chat.modes = [{ id: "plan", label: "Plan", args: [] }];
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
    chat.modes = [{ id: "plan", label: "Plan", args: [] }];
    const caps = capabilitiesFor(null, chat);
    expect(caps.effortLevels).toEqual([]);
    expect(caps.fastMode).toBe(false);
    expect(caps.modes.map((m) => m.id)).toEqual(["plan"]);
  });
});

describe("defaultMode", () => {
  // The fallback must never be the literal "default": that is Claude's spelling
  // of the idea, and a resolver carrying it picks nothing at all on a harness
  // whose modes are named otherwise.
  it("is the mode the adapter marks, whatever it is called", () => {
    const chat = adapter();
    chat.modes = [
      { id: "yolo", label: "Yolo", args: [] },
      { id: "auto_edit", label: "Auto edit", args: [], default: true },
    ];
    expect(defaultMode(chat)?.id).toBe("auto_edit");
  });

  it("falls back to the first declared mode, not to a name", () => {
    const chat = adapter();
    chat.modes = [
      { id: "yolo", label: "Yolo", args: [] },
      { id: "auto_edit", label: "Auto edit", args: [] },
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
});
