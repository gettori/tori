import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import ModeSelector, { needsPermissiveCaveat } from "./ModeSelector";
import { capabilitiesFor, pickableModels } from "../../utils/chatModels";
import type { ChatConfig, ChatMode } from "../../utils/agents";
import type { ChatModelInfo } from "../../utils/chatTypes";

// A harness whose modes are named nothing like Claude's. These are Gemini's
// real `--approval-mode` values, and the point of using them is that none is
// the literal "default" the pill used to fall back to, and none is
// "bypassPermissions" - so a component still keyed on either string fails here.
const GEMINI_MODES: ChatMode[] = [
  { id: "yolo", label: "Yolo", hint: "Runs without asking.", args: [], permissive_caveat: true },
  { id: "auto_edit", label: "Auto edit", hint: "Edits go through.", args: [], default: true },
];

function foreign(modes: ChatMode[]): ChatConfig {
  return {
    transport: "claude_stream_json",
    program: "gemini",
    base_args: [],
    session_id_args: [],
    resume_args: [],
    model_args: [],
    effort_args: [],
    mode_args: ["--approval-mode", "{mode}"],
    add_dir_args: [],
    models: [],
    modes,
    effort: [],
  };
}

/** The last portaled menu, since earlier renders leave theirs in the document. */
function openMenu(getByLabelText: (t: string) => HTMLElement) {
  fireEvent.click(getByLabelText("Permission mode"));
  const menus = document.querySelectorAll('[role="menu"]');
  return menus[menus.length - 1] as HTMLElement;
}

describe("ModeSelector", () => {
  it("shows the mode the adapter marks as default, whatever it is called", () => {
    const chat = foreign(GEMINI_MODES);
    const fallback = chat.modes.find((m) => m.default)!.id;
    const { getByLabelText } = render(() => (
      <ModeSelector mode={fallback} modes={chat.modes} pending={false} disabled={false} onSelect={vi.fn()} />
    ));
    expect(getByLabelText("Permission mode").textContent).toContain("Auto edit");
  });

  // The regression this guards: the rows came from a list in the component that
  // had already drifted from the TOML it mirrored (the same mode read "Default"
  // in one and "Ask" in the other). Rows now come from the adapter, so deleting
  // one there deletes exactly that row here.
  it("renders one row per declared mode, labelled and described from the adapter", () => {
    const chat = foreign(GEMINI_MODES);
    const { getByLabelText } = render(() => (
      <ModeSelector mode="auto_edit" modes={chat.modes} pending={false} disabled={false} onSelect={vi.fn()} />
    ));
    const menu = openMenu(getByLabelText);
    expect(menu.textContent).toContain("Yolo");
    expect(menu.textContent).toContain("Runs without asking.");
    expect(menu.textContent).toContain("Auto edit");
  });

  it("drops exactly the row the adapter stopped declaring", () => {
    const chat = foreign(GEMINI_MODES.filter((m) => m.id !== "yolo"));
    const { getByLabelText } = render(() => (
      <ModeSelector mode="auto_edit" modes={chat.modes} pending={false} disabled={false} onSelect={vi.fn()} />
    ));
    const menu = openMenu(getByLabelText);
    expect(menu.textContent).not.toContain("Yolo");
    expect(menu.textContent).toContain("Auto edit");
  });

  it("selects by the adapter's id, not by a name the component knows", () => {
    const chat = foreign(GEMINI_MODES);
    const onSelect = vi.fn();
    const { getByLabelText } = render(() => (
      <ModeSelector mode="auto_edit" modes={chat.modes} pending={false} disabled={false} onSelect={onSelect} />
    ));
    const menu = openMenu(getByLabelText);
    const row = [...menu.querySelectorAll("*")].find((el) => el.textContent?.trim().startsWith("Yolo"));
    fireEvent.click(row!);
    expect(onSelect).toHaveBeenCalledWith("yolo");
  });

  it("labels a mode this build does not hardcode from the adapter's declaration", () => {
    const chat = foreign(GEMINI_MODES);
    const { getByLabelText } = render(() => (
      <ModeSelector mode="yolo" modes={chat.modes} pending={false} disabled={false} onSelect={vi.fn()} />
    ));
    const pill = getByLabelText("Permission mode").textContent ?? "";
    expect(pill).toContain("Yolo");
    expect(pill).not.toContain("Default");
  });

  it("names no mode when neither the session nor the adapter has one", () => {
    const { getByLabelText } = render(() => (
      <ModeSelector mode={null} modes={[]} pending={false} disabled={false} onSelect={vi.fn()} />
    ));
    expect(getByLabelText("Permission mode").textContent).toContain("Mode");
  });
});

describe("the permissive-mode caveat", () => {
  // Sway's PreToolUse hook runs ahead of every mode any harness has, so the
  // warning is about Sway and not about Claude. Keyed on the adapter's
  // declaration rather than the literal "bypassPermissions", it holds for a
  // harness that calls its permissive mode something else entirely.
  it("follows the adapter's declaration, not a mode named bypassPermissions", () => {
    const chat = foreign(GEMINI_MODES);
    expect(needsPermissiveCaveat(chat, "yolo")).toBe(true);
    expect(needsPermissiveCaveat(chat, "auto_edit")).toBe(false);
    // The string the old check keyed on is not even declared here.
    expect(needsPermissiveCaveat(chat, "bypassPermissions")).toBe(false);
    expect(needsPermissiveCaveat(chat, null)).toBe(false);
    expect(needsPermissiveCaveat(null, "yolo")).toBe(false);
  });
});

describe("a mode gated on a model capability", () => {
  const GATED: ChatMode[] = [
    { id: "default", label: "Ask", hint: "", args: [], default: true },
    { id: "auto", label: "Auto", hint: "Classifier decides.", args: [], requires: "supportsAutoMode" },
  ];

  function catalogue(supportsAutoMode: boolean): ChatModelInfo[] {
    return [
      {
        value: "m",
        resolvedModel: "m",
        displayName: "M",
        description: "",
        supportsEffort: false,
        supportedEffortLevels: [],
        supportsAutoMode,
      },
    ];
  }

  // Measured on claude 2.1.220: a model without `supportsAutoMode` accepts
  // `--permission-mode auto`, exits 0, and silently runs `default`. Nothing at
  // runtime contradicts the pick, so offering the row is what would lie.
  it("is hidden for a model that does not declare the capability", () => {
    const chat = foreign(GATED);
    const model = pickableModels(catalogue(false), chat)[0];
    const { getByLabelText } = render(() => (
      <ModeSelector
        mode="default"
        modes={capabilitiesFor(model, chat).modes}
        pending={false}
        disabled={false}
        onSelect={vi.fn()}
      />
    ));
    const menu = openMenu(getByLabelText);
    expect(menu.textContent).not.toContain("Auto");
    expect(menu.textContent).toContain("Ask");
  });

  it("is offered to a model that does declare it", () => {
    const chat = foreign(GATED);
    const model = pickableModels(catalogue(true), chat)[0];
    const { getByLabelText } = render(() => (
      <ModeSelector
        mode="default"
        modes={capabilitiesFor(model, chat).modes}
        pending={false}
        disabled={false}
        onSelect={vi.fn()}
      />
    ));
    expect(openMenu(getByLabelText).textContent).toContain("Auto");
  });
});
