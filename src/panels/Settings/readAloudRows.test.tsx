import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const previewVoice = vi.hoisted(() => vi.fn(async (_o: unknown) => ({ success: true })));
vi.mock("tauri-plugin-tts-api", () => ({
  getVoices: async () => VOICES.map((v) => ({ ...v })),
  previewVoice,
  speak: vi.fn(async () => ({ success: true })),
}));

import { pointerClick } from "../../test/menus";
import ChatPane from "./panes/ChatPane/ChatPane";
import { loadWorkspaceSettings, settings } from "./settingsStore";
import { unstubbed } from "../../test/settingsBackend";

const VOICES = vi.hoisted(() => [
  { id: "daniel", name: "Daniel", language: "en-GB" },
  { id: "samantha", name: "Samantha", language: "en-US" },
]);

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "set_settings") return args.settings;
    return unstubbed(cmd);
  });
  await loadWorkspaceSettings(null);
});

const paneProps = { shown: () => true, query: "" };
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the Read aloud settings group", () => {
  it("lists the installed voices after the system one, and keeps the pick", async () => {
    render(() => <ChatPane {...paneProps} />);
    await macrotask();
    pointerClick(screen.getByLabelText("Voice"));
    await screen.findByRole("listbox");
    const names = screen.getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual(["System voice", "Daniel (en-GB)", "Samantha (en-US)"]);

    pointerClick(screen.getByRole("option", { name: "Samantha (en-US)" }));
    await macrotask();
    expect(settings.speech.voice).toBe("samantha");
  });

  it("previews the picked voice through the plugin", async () => {
    render(() => <ChatPane {...paneProps} />);
    await macrotask();
    pointerClick(screen.getByLabelText("Voice"));
    await screen.findByRole("listbox");
    pointerClick(screen.getByRole("option", { name: "Daniel (en-GB)" }));
    await macrotask();

    fireEvent.click(screen.getByRole("button", { name: "Hear this voice" }));
    expect(previewVoice).toHaveBeenCalledWith(expect.objectContaining({ voiceId: "daniel" }));
  });
});
