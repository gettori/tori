import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { pointerClick } from "../../test/menus";
import ChatPane from "./panes/ChatPane/ChatPane";
import { loadWorkspaceSettings, settings } from "./settingsStore";
import { unstubbed } from "../../test/settingsBackend";

const VOICES = [
  { id: "af_heart", name: "Heart", language: "en-US" },
  { id: "am_michael", name: "Michael", language: "en-US" },
  { id: "bf_emma", name: "Emma", language: "en-GB" },
];

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "set_settings") return args.settings;
    if (cmd === "speech_voices") return VOICES;
    if (cmd === "speech_speak") return 1;
    return unstubbed(cmd);
  });
  await loadWorkspaceSettings(null);
});

const paneProps = { shown: () => true, query: "" };
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the Read aloud settings group", () => {
  it("lists the downloaded voices after Heart, the default, and keeps the pick", async () => {
    render(() => <ChatPane {...paneProps} />);
    await macrotask();
    pointerClick(screen.getByLabelText("Voice"));
    await screen.findByRole("listbox");
    const names = screen.getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual(["Heart (en-US)", "Michael (en-US)", "Emma (en-GB)"]);

    pointerClick(screen.getByRole("option", { name: "Emma (en-GB)" }));
    await macrotask();
    expect(settings.speech.voice).toBe("bf_emma");
  });

  it("previews the picked voice through the engine", async () => {
    render(() => <ChatPane {...paneProps} />);
    await macrotask();
    pointerClick(screen.getByLabelText("Voice"));
    await screen.findByRole("listbox");
    pointerClick(screen.getByRole("option", { name: "Michael (en-US)" }));
    await macrotask();

    fireEvent.click(screen.getByRole("button", { name: "Hear this voice" }));
    await macrotask();
    expect(invoke).toHaveBeenCalledWith("speech_speak", expect.objectContaining({ voice: "am_michael" }));
  });

  it("says the chip's speed is this same setting", () => {
    render(() => <ChatPane {...paneProps} />);
    expect(screen.getByText(/The speed on the reading chip changes this same setting/)).toBeTruthy();
  });
});
