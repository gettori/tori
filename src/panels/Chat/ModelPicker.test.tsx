import { describe, it, expect, vi } from "vitest";
import initializeCapture from "../../../dev/fixtures/claude/initialize.jsonl?raw";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";
import { expectNoAxeViolations } from "../../test/axe";
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
      supportsFastMode: false,
      supportsAdaptiveThinking: false,
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
  modes: [],
  effort_extras: [],
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
    supportsFastMode: false,
    supportsAdaptiveThinking: false,
  },
];

function setup(over: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  const onSelectModel = vi.fn();
  const onSelectEffort = vi.fn();
  const models: readonly PickableModel[] = over.models ?? pickableModels(machineModels(), []);
  const result = render(() => (
    <ModelPicker
      models={models}
      providers={[lockedProvider(claude, models)]}
      agentId="claude"
      profile={null}
      profileLabel={null}
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
      models: pickableModels([], cached),
      value: "sonnet",
    });
    expect(pills()[0].disabled).toBe(false);
    const list = openPalette();
    expect(modelNames(list)).toEqual(["Sonnet 5"]);
    // Usable means it can actually be picked, not just that it renders.
    pickModel(list, "Sonnet 5");
    expect(onSelectModel).toHaveBeenCalledWith("claude", null, expect.objectContaining({ value: "sonnet" }));
  });

  /**
   * **Two rows, one model, one name on the pill.**
   *
   * The catalogue publishes `default` and `opus[1m]` as separate rows with
   * separate labels, and both carry `claude-opus-5[1m]`. Picking either runs the
   * same thing, so a pill reading "Default" for one and "Opus" for the other is
   * naming the row that was clicked rather than the model that will answer.
   *
   * The aside comes off too: "(1M context)" is written for a menu row, and the
   * pill has room for the name and not the footnote. Both survive in the
   * tooltip, which is the one place the full row label still appears.
   */
  it("names the model rather than the row when two rows are one model", () => {
    expect(setup({ value: "default" }).pills()[0].textContent).toContain("Opus");
    expect(setup({ value: "opus[1m]" }).pills()[0].textContent).toContain("Opus");
    expect(setup({ value: "default" }).pills()[0].textContent).not.toContain("Default");

    // A row that is nobody's sibling keeps its own name, minus the aside.
    expect(setup({ value: "sonnet" }).pills()[0].textContent).toContain("Sonnet");
  });

  /**
   * On a multi-account install the model alone stops saying what would run: the
   * same name under two logins is two subscriptions. So the account rides on
   * the pill, and only there - `profileLabel` is null when there is one login,
   * which is what keeps this pill exactly as it was for everybody else.
   */
  it("names the account on the pill only when there is one to name", () => {
    expect(setup({ value: "sonnet" }).pills()[0].textContent).toBe("Sonnet");
    expect(setup({ value: "sonnet", profileLabel: "Fonn" }).pills()[0].textContent).toBe(
      "Sonnet / Fonn",
    );
  });

  it("names the account in the tooltip too", () => {
    const pill = setup({ value: "sonnet", profileLabel: "Fonn" }).pills()[0];
    pill.focus();
    fireEvent.focus(pill);
    expect(screen.getByRole("tooltip").textContent).toContain("on Fonn");
  });

  it("keeps the row's own full label in the tooltip", () => {
    const pill = setup({ value: "default" }).pills()[0];
    pill.focus();
    fireEvent.focus(pill);
    expect(screen.getByRole("tooltip").textContent).toContain("Default (recommended)");
  });

  /** The menu is the better answer to "what is this pill", and it is covering
   *  the pill anyway. The case that bites is a tooltip that was *already* open:
   *  the pointer rests long enough to raise it, then clicks, and it ends up
   *  sitting over the rows. */
  it("puts the tooltip away while the pill's own menu is open", () => {
    const s = setup({ value: "sonnet" });
    const pill = s.pills()[1];

    pill.focus();
    fireEvent.focus(pill);
    expect(screen.queryByRole("tooltip")).not.toBeNull();

    s.openEffort();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("hides the effort control for a model declaring no levels, and shows all five for one that does", () => {
    // Measured: haiku omits the effort keys entirely.
    expect(setup({ value: "haiku" }).pills()).toHaveLength(1);

    const sonnet = setup({ value: "sonnet" });
    expect(sonnet.pills()).toHaveLength(2);
    // Capitalised for the menu, not on the wire: `onSelectEffort` still sends
    // the agent's own spelling, which the send test below pins.
    expect(sonnet.rowNames(sonnet.openEffort())).toEqual([
      "Default",
      "Low",
      "Medium",
      "High",
      "Xhigh",
      "Max",
    ]);
  });

  /** The capitalisation is display only, and this is the assertion that keeps it
   *  that way: an agent's own spelling is what a switch has to send, and only
   *  the first letter is touched, so `xhigh` reads `Xhigh` rather than Sway's
   *  guess at `XHigh`. */
  it("capitalises a level for the menu and sends the agent's own spelling", () => {
    const s = setup({ value: "sonnet" });
    const menu = s.openEffort();
    const row = [...menu.children].find((r) => r.textContent?.startsWith("Xhigh"))!;
    pointerClick(row as HTMLElement);
    expect(s.onSelectEffort).toHaveBeenCalledWith("xhigh");
  });

  // A level Sway measured but this binary was not measured against. It renders
  // rather than vanishing, because a level that quietly disappears on a CLI
  // upgrade tells nobody anything, and a row that says why says what to do.
  it("offers a refused level as a row that says why, and refuses to send it", async () => {
    const sonnet = pickableModels(machineModels(), []).find((m) => m.value === "sonnet")!;
    const withExtra: PickableModel = {
      ...sonnet,
      effortLevels: [
        ...sonnet.effortLevels,
        { level: "ultracode", label: "Ultracode", disabled: true, note: "Measured on 2.1.237, and this is 2.1.240." },
      ],
    };
    const s = setup({ models: [withExtra], value: "sonnet" });
    const menu = s.openEffort();
    expect(s.rowNames(menu)).toEqual([
      "Default",
      "Low",
      "Medium",
      "High",
      "Xhigh",
      "Max",
      "Ultracode",
    ]);

    const refused = [...menu.children].find((r) => r.textContent?.includes("Ultracode"))!;
    // Announced as refused, and still a row keyboard navigation can reach: a
    // row Kobalte's `disabled` skipped would take its reason with it.
    expect(refused.getAttribute("aria-disabled")).toBe("true");
    expect(refused.getAttribute("data-disabled")).toBeNull();
    // Drawn as well as announced, so it is not screen-reader-only.
    expect(refused.textContent).toContain("Measured on 2.1.237, and this is 2.1.240.");

    fireEvent.click(refused as HTMLElement);
    expect(s.onSelectEffort).not.toHaveBeenCalled();
    await expectNoAxeViolations(menu);
  });

  /**
   * **"No level sent" is a state, and it is the one every chat starts in.**
   *
   * Nothing on the wire reports effort back and no catalogue names a default
   * among its levels, so Sway cannot say which one the CLI runs. What it can
   * say is that it has sent none, which is exactly what the pill has always
   * read. The menu used to have no row for it, so nothing was ticked while the
   * pill said "Default" - and once a level was picked there was no way back.
   *
   * The row sends `null`, which is what `chat_set_model` already takes for "no
   * `--effort` flag". Naming a level as the default instead would be Sway
   * asserting something the handshake never told it.
   */
  it("offers the CLI's own default as a row, ticked until a level is picked", () => {
    const s = setup({ value: "sonnet", effort: null });
    expect(s.pills()[1].textContent).toContain("Default");

    const menu = s.openEffort();
    const row = [...menu.children].find((r) => r.textContent?.startsWith("Default"))!;
    expect(row.getAttribute("aria-selected") ?? row.querySelector("[class*=pickCheckOn]")).toBeTruthy();
  });

  it("sends null when the default row is picked, not a level and not a flag", () => {
    const s = setup({ value: "sonnet", effort: "high" });
    const menu = s.openEffort();
    const row = [...menu.children].find((r) => r.textContent?.startsWith("Default"))!;
    pointerClick(row as HTMLElement);
    expect(s.onSelectEffort).toHaveBeenCalledWith(null);
  });

  // The context readout deliberately does not live here. It sits in the status
  // strip, which is the one place the session's figures are read, and having it
  // in both put the same number in two rows that update on different sources.
  it("carries no context readout, which belongs to the status strip", () => {
    expect(setup({ value: "sonnet" }).queryByText(/context/)).toBeNull();
    expect(setup({ value: "sonnet" }).container.textContent).not.toContain("200k");
  });

  // The promise itself is one line above the input now, said once for all three
  // controls (`pendingSwitchNotice`). What stays here is the pill's own mark: a
  // tint, which is the half that has to be *on* the control the user just used
  // and the half that costs the bar no width.
  it("marks the pending pill without putting a sentence in the bar", () => {
    expect(setup({ modelPending: true }).queryByText(/next turn/)).toBeNull();
    expect(setup({ effortPending: true }).queryByText(/next turn/)).toBeNull();
    const pending = setup({ modelPending: true }).getByLabelText("Model");
    expect(pending.className).not.toBe(setup().getByLabelText("Model").className);
  });

  it("hands back the whole entry, so the caller has the resolved id a pick is confirmed by", () => {
    const { openPalette, pickModel, onSelectModel } = setup();
    pickModel(openPalette(), "Haiku");
    expect(onSelectModel).toHaveBeenCalledWith(
      "claude",
      null,
      expect.objectContaining({ value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" }),
    );
  });

  // The bar used to carry a standing note whenever the list came from the probe
  // cache. It said the same thing on every draft ever opened, which made the
  // provenance a permanent fixture of a surface that shows its plumbing only
  // when something has gone wrong. A cached row the agent has since dropped
  // fails the send, and that is where it gets explained.
  it("says nothing about where the list came from", () => {
    const r = setup({ models: pickableModels([], cached), value: "sonnet" });
    expect(r.queryByText(/Last known list/)).toBeNull();
    expect(r.container.querySelector(`.${styles.barNote}`)).toBeNull();
  });

  // Nothing cached and no handshake is a real state now that the adapter table
  // is gone. The pill still opens: with the palette behind it, an empty list is
  // a thing to look at rather than a reason to bar the door.
  it("opens on nothing to pick, and says the list is empty rather than pretending", () => {
    const { pills, openPalette } = setup({ models: pickableModels([], []), value: null });
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
