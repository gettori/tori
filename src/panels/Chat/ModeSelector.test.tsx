import { describe, it, expect, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import ModeSelector from "./ModeSelector";
import type { ChatConfig, ChatMode } from "../../utils/agents";

// A harness whose modes are named nothing like Claude's. These are Gemini's
// real `--approval-mode` values, and the point of using them is that none is
// the literal "default" the pill used to fall back to: a fixture that shared
// Claude's spelling could not tell a resolver reading the adapter apart from
// one hardcoding the string.
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

const GEMINI_MODES: ChatMode[] = [
  { id: "yolo", label: "Yolo", args: [] },
  { id: "auto_edit", label: "Auto edit", args: [], default: true },
];

describe("ModeSelector", () => {
  it("shows the mode the adapter marks as default, whatever it is called", () => {
    const chat = foreign(GEMINI_MODES);
    // What ChatView computes when the session has reported no mode: the
    // adapter's declared default rather than a literal.
    const fallback = chat.modes.find((m) => m.default)!.id;
    const { getByLabelText } = render(() => (
      <ModeSelector mode={fallback} chat={chat} pending={false} disabled={false} onSelect={vi.fn()} />
    ));
    expect(getByLabelText("Permission mode").textContent).toContain("Auto edit");
  });

  // The regression this guards: the pill read the label out of a hardcoded
  // list, so a mode only the adapter knew about fell through to "Default" - a
  // value absent from the menu the pill itself opens.
  it("labels a mode this build does not hardcode from the adapter's declaration", () => {
    const chat = foreign(GEMINI_MODES);
    const { getByLabelText } = render(() => (
      <ModeSelector mode="yolo" chat={chat} pending={false} disabled={false} onSelect={vi.fn()} />
    ));
    const pill = getByLabelText("Permission mode").textContent ?? "";
    expect(pill).toContain("Yolo");
    expect(pill).not.toContain("Default");
  });

  // Never a guess: with nothing reported and nothing declared there is no mode
  // to name, and naming one would be a claim about what the agent may do.
  it("names no mode when neither the session nor the adapter has one", () => {
    const { getByLabelText } = render(() => (
      <ModeSelector mode={null} chat={foreign([])} pending={false} disabled={false} onSelect={vi.fn()} />
    ));
    expect(getByLabelText("Permission mode").textContent).toContain("Mode");
  });
});
