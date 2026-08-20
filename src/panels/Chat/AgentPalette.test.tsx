import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import AgentPalette from "./AgentPalette";
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

describe("AgentPalette", () => {
  it("renders both panes: every agent, and the highlighted one's models", () => {
    setup();
    const panes = screen.getAllByRole("listbox");
    expect(panes.map((p) => p.getAttribute("aria-label"))).toEqual(["Agents", "Models"]);
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("Sonnet")).toBeTruthy();
    expect(screen.getByText("Haiku")).toBeTruthy();
  });

  it("selects a model with the keyboard alone", () => {
    const { filter, onSelect } = setup();
    expect(active(filter)).toBe("models-sonnet");
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    expect(active(filter)).toBe("models-haiku");
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("claude", expect.objectContaining({ value: "haiku" }));
  });

  it("wraps the arrows rather than stopping at the end", () => {
    const { filter } = setup();
    fireEvent.keyDown(filter, { key: "ArrowUp" });
    expect(active(filter)).toBe("models-haiku");
  });

  it("switches panes on Tab, and Enter on an agent moves to its models", () => {
    const { filter, onSelect } = setup();
    fireEvent.keyDown(filter, { key: "Tab" });
    expect(active(filter)).toBe("providers-claude");
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(active(filter)).toBe("models-sonnet");
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("claude", expect.objectContaining({ value: "sonnet" }));
  });

  it("filters across every agent at once", () => {
    const { filter } = setup();
    fireEvent.input(filter, { target: { value: "gpt" } });
    expect(screen.queryByText("Claude")).toBeNull();
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("GPT-5")).toBeTruthy();
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
    expect(onHighlight).toHaveBeenCalledWith("codex");
  });

  it("shows a broken agent, and selects nothing from it", () => {
    const { filter, onSelect, onFix } = setup();
    fireEvent.keyDown(filter, { key: "Tab" });
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    // Its models are listed, so the reader can see what they are missing.
    expect(screen.getByText("GPT-5")).toBeTruthy();
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
    expect(marked).toEqual(["providers-claude", "models-sonnet"]);
  });

  it("offers one agent when it is handed one, which is the whole of the lock", () => {
    setup({ providers: [claude] });
    expect(screen.queryByText("Codex")).toBeNull();
    expect(screen.getByText("Claude")).toBeTruthy();
  });
});
