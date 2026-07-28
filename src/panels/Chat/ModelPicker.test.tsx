import { describe, it, expect, vi } from "vitest";
import initializeCapture from "../../../dev/fixtures/claude/initialize.jsonl?raw";
import { render, fireEvent } from "@solidjs/testing-library";
import ModelPicker from "./ModelPicker";
import { pickableModels } from "../../utils/chatModels";
import type { ChatConfig } from "../../utils/agents";
import type { ChatModelInfo } from "../../utils/chatTypes";

// This machine's real catalogue, read out of the same committed probe capture
// the Rust mapper test asserts against. Hand-writing a model list here would
// prove the picker renders a list, not that it renders *these* models.
function machineModels(): ChatModelInfo[] {
  const frames = initializeCapture
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { type: string; response?: { response?: { models?: unknown[] } } });
  const models = frames.find((f) => f.type === "control_response")?.response?.response?.models;
  if (!models) throw new Error("the initialize capture carries no model catalogue");
  return (models as Record<string, unknown>[]).map(
    (m): ChatModelInfo => ({
      value: m.value as string,
      resolvedModel: m.resolvedModel as string,
      displayName: (m.displayName as string) ?? "",
      description: (m.description as string) ?? "",
      supportsEffort: (m.supportsEffort as boolean) ?? false,
      supportedEffortLevels: (m.supportedEffortLevels as string[]) ?? [],
    }),
  );
}

// The adapter's hand-maintained table, the fallback for a session that never
// handshook.
const adapter: ChatConfig = {
  transport: "claude_stream_json",
  program: "claude",
  base_args: [],
  session_id_args: [],
  resume_args: [],
  model_args: [],
  effort_args: [],
  mode_args: [],
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
  ],
  modes: [],
  effort: [],
};

function setup(over: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  const onSelectModel = vi.fn();
  const onSelectEffort = vi.fn();
  const result = render(() => (
    <ModelPicker
      models={pickableModels(machineModels(), adapter)}
      value="sonnet"
      effort={null}
      contextTokens={null}
      modelPending={false}
      effortPending={false}
      disabled={false}
      onSelectModel={onSelectModel}
      onSelectEffort={onSelectEffort}
      {...over}
    />
  ));
  const selects = () => [...result.container.querySelectorAll("select")] as HTMLSelectElement[];
  return { ...result, selects, onSelectModel, onSelectEffort };
}

describe("ModelPicker", () => {
  it("lists this machine's real models by display name", () => {
    const { selects } = setup();
    const options = [...selects()[0].options].map((o) => o.textContent);
    expect(options).toContain("Default (recommended)");
    expect(options).toContain("Sonnet");
    expect(options).toContain("Haiku");
    expect(options).toHaveLength(5);
  });

  it("renders a usable picker from the adapter table when there was no handshake", () => {
    const { selects, onSelectModel } = setup({
      models: pickableModels([], adapter),
      value: "claude-sonnet-5",
    });
    const model = selects()[0];
    expect(model.disabled).toBe(false);
    expect([...model.options].map((o) => o.textContent)).toEqual(["Sonnet 5"]);
    // Usable means it can actually be picked, not just that it renders.
    fireEvent.change(model, { target: { value: "claude-sonnet-5" } });
    expect(onSelectModel).toHaveBeenCalledWith(expect.objectContaining({ value: "claude-sonnet-5" }));
  });

  it("hides the effort control for a model declaring no levels, and shows all five for one that does", () => {
    // Measured: haiku omits the effort keys entirely.
    expect(setup({ value: "haiku" }).selects()).toHaveLength(1);

    const sonnet = setup({ value: "sonnet" }).selects();
    expect(sonnet).toHaveLength(2);
    // The leading blank is the unselectable "Default" placeholder: before a
    // pick, the level in force is the CLI's own and Sway does not know it.
    const levels = [...sonnet[1].options];
    expect(levels[0].disabled).toBe(true);
    expect(levels.slice(1).map((o) => o.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("shows the context window only when one is declared", () => {
    // The live catalogue carries no window; the adapter declares one for
    // sonnet's resolved id and nothing for haiku's.
    expect(setup({ value: "sonnet" }).getByText("200k context")).toBeTruthy();
    expect(setup({ value: "haiku" }).queryByText(/context$/)).toBeNull();
  });

  it("meters usage against the window, and renders no meter without one", () => {
    const used = setup({ value: "sonnet", contextTokens: 50000 });
    expect(used.getByTitle("25% of 200k context used")).toBeTruthy();
    // The figures render as separate text nodes, so this reads the row.
    expect(used.container.textContent).toContain("50k/200k");

    // No declared window means no denominator, so no meter at all - not a
    // meter against a number nothing declared.
    const noWindow = setup({ value: "haiku", contextTokens: 50000 });
    expect(noWindow.container.textContent).not.toContain("50k");
    expect(noWindow.container.querySelectorAll("span[title]")).toHaveLength(0);
  });

  it("promises the next turn rather than claiming a switch took effect", () => {
    expect(setup().queryByText("Applies from the next turn.")).toBeNull();
    expect(setup({ modelPending: true }).getByText("Applies from the next turn.")).toBeTruthy();
    // Effort lands at the same boundary and says so in the same words.
    expect(setup({ effortPending: true }).getByText("Applies from the next turn.")).toBeTruthy();
  });

  it("hands back the whole entry, so the caller has the resolved id a pick is confirmed by", () => {
    const { selects, onSelectModel } = setup();
    fireEvent.change(selects()[0], { target: { value: "haiku" } });
    expect(onSelectModel).toHaveBeenCalledWith(
      expect.objectContaining({ value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" }),
    );
  });

  it("says when the list came from the adapter rather than the session", () => {
    expect(setup({ models: pickableModels([], adapter), value: "claude-sonnet-5" }).getByText(/adapter's list/)).toBeTruthy();
    expect(setup().queryByText(/adapter's list/)).toBeNull();
  });
});
