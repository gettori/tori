import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@solidjs/testing-library";
import AgentPalette from "./AgentPalette";
import styles from "./AgentPalette.module.css";
import { lockedProvider, type PaletteProvider } from "./agentPaletteData";
import type { Adapter } from "../../utils/agents";
import type { PickableModel } from "../../utils/chatModels";

function adapter(id: string, label: string): Adapter {
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
    chat: null,
  };
}

function model(value: string, label: string): PickableModel {
  return {
    value,
    resolvedModel: value,
    label,
    description: "",
    effortLevels: [],
    contextWindow: null,
    live: false,
    userConfigured: false,
    fastMode: false,
    supportsAutoMode: false,
  };
}

const claude = lockedProvider(adapter("claude", "Claude"), [
  model("sonnet", "Sonnet"),
  model("haiku", "Haiku"),
]);
const codex: PaletteProvider = {
  ...lockedProvider(adapter("codex", "Codex"), [model("gpt-5", "GPT-5")]),
  health: { kind: "fix", reason: "Signed out" },
  selectable: false,
};

function setup(over: Partial<Parameters<typeof AgentPalette>[0]> = {}) {
  const onSelect = vi.fn();
  const onFix = vi.fn();
  const onHighlight = vi.fn();
  const onClose = vi.fn();
  render(() => (
    <AgentPalette
      providers={[claude, codex]}
      agentId="claude"
      profile={null}
      value="sonnet"
      onSelect={onSelect}
      onFix={onFix}
      onHighlight={onHighlight}
      onClose={onClose}
      {...over}
    />
  ));
  const filter = screen.getByRole("combobox");
  return { filter, onSelect, onFix, onHighlight, onClose };
}

/** The row `aria-activedescendant` currently names, minus the per-instance
 *  prefix, which is the row Enter would take. Reading the attribute rather than
 *  a class keeps the assertion on what a screen reader is told. */
const active = (filter: HTMLElement) =>
  filter.getAttribute("aria-activedescendant")?.replace(/^.*?-(providers|models)-/, "$1-") ?? null;

/** Scoped to one list. The models pane names its agent in its own heading, so
 *  an unscoped query for "Claude" now finds the row *and* the heading, and the
 *  question these tests are asking is always which list a name is in. */
const inAgents = () => within(screen.getByRole("listbox", { name: "Agents" }));
const inModels = () => within(screen.getByRole("listbox", { name: "Models" }));

// Kobalte installs its outside listener from a setTimeout(0) and listens for
// pointerdown, so a dismissal test yields a macrotask first and fires the pair a
// real pointer sends (src/test/menuIdioms.test.ts).
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AgentPalette", () => {
  // Anchored to the pill rather than centred over the transcript. Position is
  // floating-ui's and jsdom cannot exercise it past "it mounted", so what this
  // holds is the half that is this component's: it is a labelled panel, and the
  // control it hangs off is excluded from dismissal, or the pill's own click
  // would close and reopen it in one gesture.
  it("is a labelled panel, dismissed by Escape and by an outside press", async () => {
    const anchorEl = document.createElement("button");
    document.body.append(anchorEl);
    const { filter, onClose } = setup({ anchorEl });
    expect(screen.getByRole("dialog", { name: "Pick a model" })).toBeTruthy();
    await settle();

    fireEvent.pointerDown(anchorEl);
    fireEvent.mouseDown(anchorEl);
    expect(onClose).not.toHaveBeenCalled();

    // Escape reaches the layer past the filter's own handler, which claims the
    // arrows, Tab and Enter and nothing else.
    fireEvent.keyDown(filter, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    onClose.mockClear();
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    anchorEl.remove();
  });

  it("renders both panes: every agent, and the highlighted one's models", () => {
    setup();
    const panes = screen.getAllByRole("listbox");
    expect(panes.map((p) => p.getAttribute("aria-label"))).toEqual(["Agents", "Models"]);
    expect(inAgents().getByText("Claude")).toBeTruthy();
    expect(inAgents().getByText("Codex")).toBeTruthy();
    expect(inModels().getByText("Sonnet")).toBeTruthy();
    expect(inModels().getByText("Haiku")).toBeTruthy();
  });

  it("selects a model with the keyboard alone", () => {
    const { filter, onSelect } = setup();
    expect(active(filter)).toBe("models-sonnet");
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    expect(active(filter)).toBe("models-haiku");
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("claude", null, expect.objectContaining({ value: "haiku" }));
  });

  // The bug this pins: `model()` falls back to the first row so Enter always
  // has an answer, and painting that fallback put a fill on the first row of
  // every list nobody had touched - a draft with no pick yet, or any agent the
  // reader had just moved to. The cursor is drawn only once it is somewhere
  // somebody named, and the first press names an end rather than stepping off
  // a row nobody could see.
  it("paints no cursor until one is named, then starts at the end pressed toward", () => {
    const { filter } = setup({ value: null });
    // Scoped to the models list: the agent row carries the same class all the
    // while, which is its own decision (it names what the right pane is of).
    const lit = () =>
      [
        ...screen
          .getByRole("listbox", { name: "Models" })
          .querySelectorAll(`[role="option"].${styles.rowActive}`),
      ].map((o) => o.id.replace(/^.*?-models-/, ""));
    expect(lit()).toEqual([]);
    expect(active(filter)).toBeNull();

    fireEvent.keyDown(filter, { key: "ArrowDown" });
    expect(lit()).toEqual(["sonnet"]);
  });

  // The same rule from the other side: the model in force is marked as running
  // (wash and check) from the moment the palette opens, and painting the cursor
  // on it too would say "hovered" about a row nobody has touched.
  it("leaves the model in force unhovered until the reader moves", () => {
    const { filter } = setup();
    const inModelsList = () => screen.getByRole("listbox", { name: "Models" });
    expect(inModelsList().querySelector(`.${styles.rowActive}`)).toBeNull();
    // Still the row Enter takes, and still announced as such.
    expect(active(filter)).toBe("models-sonnet");

    fireEvent.keyDown(filter, { key: "ArrowDown" });
    expect(inModelsList().querySelector(`.${styles.rowActive}`)?.id).toMatch(/models-haiku$/);
  });

  it("takes the far end when the first press is Up", () => {
    const { filter } = setup({ value: null });
    fireEvent.keyDown(filter, { key: "ArrowUp" });
    expect(active(filter)).toBe("models-haiku");
  });

  // Enter still answers before anything is painted: the fallback is what makes
  // the palette usable on its first keypress.
  it("commits the first row when Enter comes before any move", () => {
    const { filter, onSelect } = setup({ value: null });
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("claude", null, expect.objectContaining({ value: "sonnet" }));
  });

  it("wraps the arrows rather than stopping at the end", () => {
    const { filter } = setup();
    fireEvent.keyDown(filter, { key: "ArrowUp" });
    expect(active(filter)).toBe("models-haiku");
  });

  it("switches panes on Tab, and Enter on an agent moves to its models", () => {
    const { filter, onSelect } = setup();
    fireEvent.keyDown(filter, { key: "Tab" });
    expect(active(filter)).toBe("providers-claude-default");
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(active(filter)).toBe("models-sonnet");
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("claude", null, expect.objectContaining({ value: "sonnet" }));
  });

  // The placeholder is the inventory of the whole hand: a draft names both
  // axes, a locked session drops the provider clause rather than counting to
  // one.
  it("says in the placeholder what there is to filter", () => {
    expect(setup().filter.getAttribute("placeholder")).toBe("Filter 3 models across 2 providers");
  });

  it("filters across every agent at once", () => {
    const { filter } = setup();
    fireEvent.input(filter, { target: { value: "gpt" } });
    expect(inAgents().queryByText("Claude")).toBeNull();
    expect(inAgents().getByText("Codex")).toBeTruthy();
    expect(inModels().getByText("GPT-5")).toBeTruthy();
  });

  it("says so rather than emptying the panes when nothing matches", () => {
    const { filter } = setup();
    fireEvent.input(filter, { target: { value: "zzzz" } });
    expect(screen.getByText("No agents match")).toBeTruthy();
  });

  it("reports a highlight so the caller can decide whether to probe", () => {
    const { filter, onHighlight } = setup();
    fireEvent.keyDown(filter, { key: "Tab" });
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    expect(onHighlight).toHaveBeenCalledWith("codex", null);
  });

  it("shows a broken agent, and selects nothing from it", () => {
    const { filter, onSelect, onFix } = setup();
    fireEvent.keyDown(filter, { key: "Tab" });
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    // Its models are listed, so the reader can see what they are missing.
    expect(inModels().getByText("GPT-5")).toBeTruthy();
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onFix).toHaveBeenCalledWith("codex");
  });

  it("does not commit a model belonging to a broken agent", () => {
    const { filter, onSelect } = setup();
    fireEvent.keyDown(filter, { key: "Tab" });
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    fireEvent.keyDown(filter, { key: "Tab" });
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("marks the model in force, and only on the agent in force", () => {
    setup();
    const marked = screen
      .getAllByRole("option")
      .filter((o) => o.getAttribute("aria-selected") === "true")
      .map((o) => o.id.replace(/^.*?-(providers|models)-/, "$1-"));
    expect(marked).toEqual(["providers-claude-default", "models-sonnet"]);
  });

  // The bug this pins: the fill was gated on the agents pane having the
  // keyboard, and the palette opens with the keyboard in the models pane, so
  // the agent whose models were on screen was marked nowhere at all.
  it("marks the agent whose models are showing, before the arrows go near it", () => {
    const { filter } = setup();
    const rowFor = (agentId: string) =>
      screen.getAllByRole("option").find((o) => o.id.includes(`providers-${agentId}`))!;
    expect(rowFor("claude").className).toContain(styles.rowActive);
    expect(rowFor("codex").className).not.toContain(styles.rowActive);

    // And it follows the arrows once they are in this column.
    fireEvent.keyDown(filter, { key: "Tab" });
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    expect(rowFor("codex").className).toContain(styles.rowActive);
    expect(rowFor("claude").className).not.toContain(styles.rowActive);
  });

  // The model in force wears the panel's one selection colour and a check by
  // its name.
  it("checks the current model, on the agent in force", () => {
    setup();
    const checks = [...document.querySelectorAll(`.${styles.check}`)];
    // One row, not one per agent: the value alone would match another agent's
    // model of the same name.
    expect(checks).toHaveLength(1);
    expect(checks[0].closest('[role="option"]')?.id).toMatch(/models-sonnet$/);
    expect(checks[0].closest('[role="option"]')?.className).toContain(styles.rowCurrent);
  });

  // The way out of every state the palette can only report. Both routes land in
  // the same place, so a reader who cannot see what they want is never left
  // reading a panel with nothing to do.
  it("opens the highlighted agent's settings, from the footer and from cmd-comma", () => {
    const { filter, onFix } = setup();
    fireEvent.click(screen.getByRole("button", { name: /agent settings/ }));
    expect(onFix).toHaveBeenCalledWith("claude");

    onFix.mockClear();
    fireEvent.keyDown(filter, { key: "Tab" });
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    fireEvent.keyDown(filter, { key: ",", metaKey: true });
    expect(onFix).toHaveBeenCalledWith("codex");
  });

  // The heading is the only thing naming what the right-hand list belongs to,
  // and for an agent Sway cannot reach it is also the only thing saying why the
  // list is short.
  it("heads the model list with the agent and what it has to offer", () => {
    const { filter } = setup();
    const fact = () => document.querySelector(`.${styles.headFact}`)?.textContent;
    expect(fact()).toBe("2");
    fireEvent.keyDown(filter, { key: "Tab" });
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    expect(fact()).toBe("signed out");
  });

  // A catalogue is an account's answer, so an agent with two logins is two
  // rows. They share an `agentId`, which is why nothing here may key on it: the
  // highlight, the marks and the recheck all have to name a pair.
  describe("two accounts of one agent", () => {
    const onFonn = (over: Partial<PaletteProvider> = {}): PaletteProvider => ({
      ...lockedProvider(adapter("claude", "Claude"), [model("opus", "Opus")], {
        profile: "fonn",
        account: "Fonn",
      }),
      plan: "Claude Team",
      ...over,
    });

    it("marks the row this chat is actually on, not the other one", () => {
      setup({ providers: [claude, onFonn()], agentId: "claude", profile: "fonn" });
      const rows = screen.getAllByRole("option").filter((o) => o.id.includes("providers-"));
      expect(rows.map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    });

    // The plan is what says whose answer this list is, and it only means
    // anything once there are two accounts to tell apart.
    it("heads the list with the account's plan beside the count", () => {
      setup({ providers: [onFonn()], agentId: "claude", profile: "fonn" });
      expect(document.querySelector(`.${styles.headFact}`)?.textContent).toBe("Claude Team, 1");
    });

    it("selects and rechecks the pair, not the agent", () => {
      const onRecheck = vi.fn();
      const { onSelect, filter } = setup({
        providers: [onFonn()],
        agentId: "claude",
        profile: "fonn",
        onRecheck,
      });
      fireEvent.click(screen.getByRole("button", { name: /check claude \/ fonn for new models/i }));
      expect(onRecheck).toHaveBeenCalledWith("claude", "fonn");

      fireEvent.keyDown(filter, { key: "Enter" });
      expect(onSelect).toHaveBeenCalledWith("claude", "fonn", expect.objectContaining({ value: "opus" }));
    });
  });

  // The version is a claim with an owner (the health sweep, else the probe),
  // so it renders only when a provider carries one.
  it("names the agent with its version when one is known, and plainly when not", () => {
    setup({ providers: [{ ...claude, version: "2.1.220" }] });
    expect(screen.getByText("v2.1.220")).toBeTruthy();
  });

  it("says nothing about a version nobody reported", () => {
    setup();
    expect(screen.queryByText(/^v\d/)).toBeNull();
  });

  // Each model is two lines: its name, then whatever the provider said about
  // it. Claude ships a sentence; an ACP catalogue ships only ids, so the id
  // stands in; a label that already is the id gets no echo beneath it.
  it("seconds each model with its description, else its id, else nothing", () => {
    const described = { ...model("sonnet", "Sonnet"), description: "Smartest for daily use" };
    setup({
      providers: [
        lockedProvider(adapter("claude", "Claude"), [
          described,
          model("github-copilot/gpt-5", "GitHub Copilot/GPT-5"),
          model("big-pickle", "big-pickle"),
        ]),
      ],
    });
    expect(inModels().getByText("Smartest for daily use")).toBeTruthy();
    expect(inModels().queryByText("sonnet")).toBeNull();
    expect(inModels().getByText("github-copilot/gpt-5")).toBeTruthy();
    expect(inModels().getAllByText("big-pickle")).toHaveLength(1);
  });

  // An agent that declared the Provider/Name convention gets its rows unpicked:
  // the bare name heads the row and the route moves to the second line. The
  // joined label must be gone, or the split would just be a duplicate.
  it("splits a flagged agent's model into a name over its route", () => {
    const opencode: PaletteProvider = {
      ...lockedProvider(adapter("opencode", "OpenCode"), [
        model("github-copilot/claude-sonnet-4.6", "GitHub Copilot/Claude Sonnet 4.6"),
      ]),
      splitModels: true,
    };
    setup({ providers: [opencode], agentId: "opencode", value: null });
    expect(inModels().getByText("Claude Sonnet 4.6")).toBeTruthy();
    expect(inModels().getByText("GitHub Copilot")).toBeTruthy();
    expect(inModels().getByText("claude-sonnet-4.6")).toBeTruthy();
    expect(inModels().queryByText("GitHub Copilot/Claude Sonnet 4.6")).toBeNull();
  });

  // The way out of a list that is right but out of date. It asks about the
  // agent whose models are showing, not the one in force, since that is the
  // list the button sits over.
  it("rechecks the agent whose list is showing, and only when a caller can", () => {
    const onRecheck = vi.fn();
    const { filter } = setup({ onRecheck });
    fireEvent.click(screen.getByRole("button", { name: /check claude for new models/i }));
    expect(onRecheck).toHaveBeenCalledWith("claude", null);

    fireEvent.keyDown(filter, { key: "Tab" });
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: /check codex for new models/i }));
    expect(onRecheck).toHaveBeenLastCalledWith("codex", null);
  });

  it("offers no recheck when nothing can act on one", () => {
    setup();
    expect(screen.queryByRole("button", { name: /check .* for new models/i })).toBeNull();
  });

  // Pressing it again while the last answer is still coming would queue a
  // second binary behind the first for no new information.
  it("bars a recheck while one is already in flight", () => {
    const probing: PaletteProvider = { ...claude, health: { kind: "probing" } };
    setup({ providers: [probing], onRecheck: vi.fn() });
    expect(
      (screen.getByRole("button", { name: /check claude for new models/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("offers one agent when it is handed one, which is the whole of the lock", () => {
    const { filter } = setup({ providers: [claude] });
    expect(inAgents().queryByText("Codex")).toBeNull();
    expect(inAgents().getByText("Claude")).toBeTruthy();
    expect(filter.getAttribute("placeholder")).toBe("Filter 2 models");
  });
});
