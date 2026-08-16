import { describe, it, expect, vi } from "vitest";
import initializeCapture from "../../../dev/fixtures/claude/initialize.jsonl?raw";
import { render } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";
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
      supportsAutoMode: false,
    }),
  );
}

// The adapter, which declares no models at all now. What a session that never
// handshook falls back to is the probe cache, below.
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
  annotations: [],
  modes: [],
  effort: [],
  acp: { serve_client_fs: false },
};

// What `catalog_probe` remembered the last time it asked. Same shape as a live
// handshake row, which is what lets the picker read one where it reads the other.
const cached = [
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet 5",
    description: "",
    supportsEffort: false,
    supportedEffortLevels: [],
    supportsAutoMode: false,
  },
];

function setup(over: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  const onSelectModel = vi.fn();
  const onSelectEffort = vi.fn();
  const result = render(() => (
    <ModelPicker
      models={pickableModels(machineModels(), [], adapter)}
      value="sonnet"
      effort={null}
      modelPending={false}
      effortPending={false}
      disabled={false}
      onSelectModel={onSelectModel}
      onSelectEffort={onSelectEffort}
      {...over}
    />
  ));
  // The pills are buttons in the container; their menus are portaled to the
  // body, so rows are read off the document rather than off the render root.
  const pills = () => [...result.container.querySelectorAll("button")] as HTMLButtonElement[];
  // `pointerClick`, not `fireEvent.click`: a Kobalte trigger opens on
  // `pointerdown` and answers a bare click with nothing (src/test/menus.ts).
  const open = (i: number) => {
    pointerClick(pills()[i]);
    // The last one: menus are portaled to the body, and a menu another render
    // in this file left behind is still a match for the first selector.
    const menus = [...document.querySelectorAll('[role="menu"]')];
    const menu = menus[menus.length - 1];
    if (!menu) throw new Error("the pill opened no menu");
    return menu as HTMLElement;
  };
  const rowNames = (menu: HTMLElement) =>
    [...menu.children].map((row) => (row.firstElementChild?.firstElementChild as HTMLElement | null)?.textContent);
  const pick = (menu: HTMLElement, name: string) => {
    const row = [...menu.children].find(
      (r) => (r.firstElementChild?.firstElementChild as HTMLElement | null)?.textContent === name,
    );
    if (!row) throw new Error(`no row named ${name}`);
    pointerClick(row as HTMLElement);
  };
  return { ...result, pills, open, rowNames, pick, onSelectModel, onSelectEffort };
}

describe("ModelPicker", () => {
  it("lists this machine's real models by display name", () => {
    const { open, rowNames } = setup();
    const names = rowNames(open(0));
    expect(names).toContain("Default (recommended)");
    expect(names).toContain("Sonnet");
    expect(names).toContain("Haiku");
    // Five is under the flat limit, so the whole catalogue is on one page and
    // there is no "More models" fold to click through.
    expect(names).toHaveLength(5);
    expect(names).not.toContain("More models");
  });

  it("carries each model's own description into its row", () => {
    // The reason to reach for one model over another is the sentence the
    // catalogue already ships; a list of bare names does not say which to pick.
    const menu = setup().open(0);
    expect(menu.textContent).toContain("Fastest for quick answers");
  });

  it("ticks only the selected row", () => {
    const menu = setup({ value: "haiku" }).open(0);
    const ticked = [...menu.children].filter((r) => r.textContent?.includes("Haiku"));
    expect(ticked).toHaveLength(1);
  });

  it("renders a usable picker from the probe cache when there was no handshake", () => {
    const { pills, open, rowNames, pick, onSelectModel } = setup({
      models: pickableModels([], cached, adapter),
      value: "sonnet",
    });
    expect(pills()[0].disabled).toBe(false);
    const menu = open(0);
    expect(rowNames(menu)).toEqual(["Sonnet 5"]);
    // Usable means it can actually be picked, not just that it renders.
    pick(menu, "Sonnet 5");
    expect(onSelectModel).toHaveBeenCalledWith(expect.objectContaining({ value: "sonnet" }));
  });

  it("hides the effort control for a model declaring no levels, and shows all five for one that does", () => {
    // Measured: haiku omits the effort keys entirely.
    expect(setup({ value: "haiku" }).pills()).toHaveLength(1);

    const sonnet = setup({ value: "sonnet" });
    expect(sonnet.pills()).toHaveLength(2);
    expect(sonnet.rowNames(sonnet.open(1))).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("says Default for an effort nothing has reported, without offering it as a level", () => {
    // Nothing on the wire reports effort back, so before a pick the level in
    // force is the CLI's own and Sway does not know which it is. Naming one
    // would be a claim; offering "Default" as a pick would send a bad flag.
    const s = setup({ value: "sonnet", effort: null });
    expect(s.pills()[1].textContent).toContain("Default");
    expect(s.rowNames(s.open(1))).not.toContain("Default");
  });

  // The context readout deliberately does not live here. It sits in the status
  // strip, which is the one place the session's figures are read, and having it
  // in both put the same number in two rows that update on different sources.
  it("carries no context readout, which belongs to the status strip", () => {
    expect(setup({ value: "sonnet" }).queryByText(/context/)).toBeNull();
    expect(setup({ value: "sonnet" }).container.textContent).not.toContain("200k");
  });

  it("promises the next turn rather than claiming a switch took effect", () => {
    expect(setup().queryByText("Applies from the next turn.")).toBeNull();
    expect(setup({ modelPending: true }).getByText("Applies from the next turn.")).toBeTruthy();
    // Effort lands at the same boundary and says so in the same words.
    expect(setup({ effortPending: true }).getByText("Applies from the next turn.")).toBeTruthy();
  });

  it("hands back the whole entry, so the caller has the resolved id a pick is confirmed by", () => {
    const { open, pick, onSelectModel } = setup();
    pick(open(0), "Haiku");
    expect(onSelectModel).toHaveBeenCalledWith(
      expect.objectContaining({ value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" }),
    );
  });

  it("says when the list is remembered rather than reported by this session", () => {
    expect(
      setup({ models: pickableModels([], cached, adapter), value: "sonnet" }).getByText(/Last known list/),
    ).toBeTruthy();
    expect(setup().queryByText(/Last known list/)).toBeNull();
  });

  // Nothing cached and no handshake is a real state now that the adapter table
  // is gone, and it used to be unreachable: the table filled this gap with
  // models the installed CLI was never asked about. The pill still renders, so
  // the toolbar keeps its shape, but there is nothing behind it to pick.
  it("offers nothing to pick when neither the session nor the cache has an answer", () => {
    const { pills, rowNames, open } = setup({ models: pickableModels([], [], adapter), value: null });
    expect(pills()[0].disabled).toBe(true);
    expect(rowNames(open(0))).toEqual([]);
  });
});
