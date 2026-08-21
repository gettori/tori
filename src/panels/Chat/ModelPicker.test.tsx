import { describe, it, expect, vi } from "vitest";
import initializeCapture from "../../../dev/fixtures/claude/initialize.jsonl?raw";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";
import ModelPicker from "./ModelPicker";
import { lockedProvider } from "./agentPaletteData";
import { pickableModels, type PickableModel } from "../../utils/chatModels";
import type { Adapter, ChatConfig } from "../../utils/agents";
import type { ChatModelInfo } from "../../utils/chatTypes";
import styles from "./Chat.module.css";

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
  effort: [],
  acp: { serve_client_fs: false },
};

const claude: Adapter = {
  id: "claude",
  label: "Claude",
  program: "claude",
  base_args: [],
  yolo_args: [],
  resume_args: [],
  parser_kind: null,
  running_pattern: null,
  pty_quiet_ms: 2000,
  chat,
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
  const models: readonly PickableModel[] = over.models ?? pickableModels(machineModels(), [], chat);
  const result = render(() => (
    <ModelPicker
      models={models}
      providers={[lockedProvider(claude, models)]}
      agentId="claude"
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
  const pills = () => [...result.container.querySelectorAll("button")] as HTMLButtonElement[];

  // The model pill opens the palette, which is a dialog portaled to the body.
  // The rows read off the document for that reason.
  const openPalette = () => {
    fireEvent.click(pills()[0]);
    const lists = [...document.querySelectorAll('[role="listbox"][aria-label="Models"]')];
    const list = lists[lists.length - 1];
    if (!list) throw new Error("the model pill opened no palette");
    return list as HTMLElement;
  };
  // A model row stacks its text: the first child is the text block, whose own
  // first child is the name, over the description or id.
  const modelNames = (list: HTMLElement) =>
    [...list.querySelectorAll('[role="option"]')].map(
      (row) => (row.firstElementChild?.firstElementChild as HTMLElement | null)?.textContent,
    );
  const pickModel = (list: HTMLElement, name: string) => {
    const row = [...list.querySelectorAll('[role="option"]')].find(
      (r) => (r.firstElementChild?.firstElementChild as HTMLElement | null)?.textContent === name,
    );
    if (!row) throw new Error(`no model row named ${name}`);
    fireEvent.click(row as HTMLElement);
  };

  // The effort pill is still a menu. `pointerClick`, not `fireEvent.click`: a
  // Kobalte trigger opens on `pointerdown` and answers a bare click with
  // nothing (src/test/menus.ts).
  const openEffort = () => {
    pointerClick(pills()[1]);
    const menus = [...document.querySelectorAll('[role="menu"]')];
    const menu = menus[menus.length - 1];
    if (!menu) throw new Error("the pill opened no menu");
    return menu as HTMLElement;
  };
  const rowNames = (menu: HTMLElement) =>
    [...menu.children].map((row) => (row.firstElementChild?.firstElementChild as HTMLElement | null)?.textContent);

  return { ...result, pills, openPalette, modelNames, pickModel, openEffort, rowNames, onSelectModel, onSelectEffort };
}

describe("ModelPicker", () => {
  it("lists this machine's real models by display name", () => {
    const { openPalette, modelNames } = setup();
    const names = modelNames(openPalette());
    expect(names).toContain("Default (recommended)");
    expect(names).toContain("Sonnet");
    expect(names).toContain("Haiku");
    // The whole catalogue, with no fold to click through: the palette scrolls
    // and filters, so the page limit the menu needed is gone.
    expect(names).toHaveLength(5);
  });

  it("carries each model's own description into its row", () => {
    // The reason to reach for one model over another is the sentence the
    // catalogue already ships; a list of bare names does not say which to pick.
    expect(setup().openPalette().textContent).toContain("Fastest for quick answers");
  });

  it("marks only the selected row", () => {
    const list = setup({ value: "haiku" }).openPalette();
    const marked = [...list.querySelectorAll('[role="option"][aria-selected="true"]')];
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toContain("Haiku");
  });

  it("renders a usable picker from the probe cache when there was no handshake", () => {
    const { pills, openPalette, modelNames, pickModel, onSelectModel } = setup({
      models: pickableModels([], cached, chat),
      value: "sonnet",
    });
    expect(pills()[0].disabled).toBe(false);
    const list = openPalette();
    expect(modelNames(list)).toEqual(["Sonnet 5"]);
    // Usable means it can actually be picked, not just that it renders.
    pickModel(list, "Sonnet 5");
    expect(onSelectModel).toHaveBeenCalledWith("claude", expect.objectContaining({ value: "sonnet" }));
  });

  it("hides the effort control for a model declaring no levels, and shows all five for one that does", () => {
    // Measured: haiku omits the effort keys entirely.
    expect(setup({ value: "haiku" }).pills()).toHaveLength(1);

    const sonnet = setup({ value: "sonnet" });
    expect(sonnet.pills()).toHaveLength(2);
    expect(sonnet.rowNames(sonnet.openEffort())).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("says Default for an effort nothing has reported, without offering it as a level", () => {
    // Nothing on the wire reports effort back, so before a pick the level in
    // force is the CLI's own and Sway does not know which it is. Naming one
    // would be a claim; offering "Default" as a pick would send a bad flag.
    const s = setup({ value: "sonnet", effort: null });
    expect(s.pills()[1].textContent).toContain("Default");
    expect(s.rowNames(s.openEffort())).not.toContain("Default");
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
    const { openPalette, pickModel, onSelectModel } = setup();
    pickModel(openPalette(), "Haiku");
    expect(onSelectModel).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({ value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" }),
    );
  });

  // The bar used to carry a standing note whenever the list came from the probe
  // cache. It said the same thing on every draft ever opened, which made the
  // provenance a permanent fixture of a surface that shows its plumbing only
  // when something has gone wrong. A cached row the agent has since dropped
  // fails the send, and that is where it gets explained.
  it("says nothing about where the list came from", () => {
    const r = setup({ models: pickableModels([], cached, chat), value: "sonnet" });
    expect(r.queryByText(/Last known list/)).toBeNull();
    expect(r.container.querySelector(`.${styles.barNote}`)).toBeNull();
  });

  // Nothing cached and no handshake is a real state now that the adapter table
  // is gone. The pill still opens: with the palette behind it, an empty list is
  // a thing to look at rather than a reason to bar the door.
  it("opens on nothing to pick, and says the list is empty rather than pretending", () => {
    const { pills, openPalette } = setup({ models: pickableModels([], [], chat), value: null });
    expect(pills()[0].disabled).toBe(false);
    expect(openPalette().querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(screen.getAllByText("No models known yet").length).toBeGreaterThan(0);
  });

  // The palette hangs off this pill now rather than covering the pane, so the
  // pill owns its open state: it says so, and a second press closes what the
  // first opened. Popover excludes the anchor's press from its own dismissal
  // precisely so this click is the only thing deciding.
  it("says whether the palette is open, and closes it on a second press", () => {
    const { pills } = setup();
    const pill = pills()[0];
    expect(pill.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(pill);
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="listbox"][aria-label="Models"]')).toBeTruthy();

    fireEvent.click(pill);
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="listbox"][aria-label="Models"]')).toBeNull();
  });
});
