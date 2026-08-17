import { describe, it, expect, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";
import ModeSelector from "./ModeSelector";
import { capabilitiesFor, pickableModels } from "../../utils/chatModels";
import type { ChatConfig, ChatMode } from "../../utils/agents";
import type { ChatModelInfo } from "../../utils/chatTypes";

// A agent whose modes are named nothing like Claude's. These are Gemini's
// real `--approval-mode` values, and the point of using them is that none is
// the literal "default" the pill used to fall back to, and none is
// "bypassPermissions" - so a component still keyed on either string fails here.
const GEMINI_MODES: ChatMode[] = [
  { id: "yolo", label: "Yolo", hint: "Runs without asking.", args: [], permissive: true },
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
    annotations: [],
    modes,
    effort: [],
    acp: { serve_client_fs: false },
  };
}

/** The last portaled menu, since earlier renders leave theirs in the document. */
function openMenu(getByLabelText: (t: string) => HTMLElement) {
  // `pointerClick`, not `fireEvent.click`: a Kobalte trigger opens on
  // `pointerdown` and answers a bare click with nothing (src/test/menus.ts).
  pointerClick(getByLabelText("Permission mode"));
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
    pointerClick(row as HTMLElement);
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

describe("a permissive mode", () => {
  // There was a caveat here - "Sway still asks", shown for any mode the adapter
  // flagged - because Sway's hook ran ahead of the permission chain and a mode
  // named after bypassing permissions did not bypass them. The hook stopped
  // deciding, so the sentence stopped being true and was removed rather than
  // reworded. What the control shows now is the mode's own hint, which is the
  // agent's description of what it really does.
  it("shows the agent's own description and adds nothing to it", () => {
    const chat = foreign(GEMINI_MODES);
    const { getByLabelText } = render(() => (
      <ModeSelector mode="yolo" modes={chat.modes} pending={false} disabled={false} onSelect={vi.fn()} />
    ));
    const menu = openMenu(getByLabelText);
    expect(menu.textContent).toContain("Runs without asking.");
    expect(document.body.textContent).not.toContain("Sway still asks");
  });

  // The chip outlived the sentence, and had to: a mode that runs tools unasked
  // now runs them with nothing behind it, so the one persistent sign that it is
  // in force is the only sign there is.
  it("marks the chip while a permissive mode is in force, and only then", () => {
    const chat = foreign(GEMINI_MODES);
    const marked = (mode: string) => {
      const { getByLabelText, unmount } = render(() => (
        <ModeSelector mode={mode} modes={chat.modes} pending={false} disabled={false} onSelect={vi.fn()} />
      ));
      const cls = getByLabelText("Permission mode").className;
      unmount();
      return cls;
    };
    // Keyed on the adapter's declaration, not on a mode named bypassPermissions:
    // this agent calls its permissive mode `yolo`.
    expect(marked("yolo")).not.toBe(marked("auto_edit"));
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
    const model = pickableModels(catalogue(false), [], chat)[0];
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
    const model = pickableModels(catalogue(true), [], chat)[0];
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
