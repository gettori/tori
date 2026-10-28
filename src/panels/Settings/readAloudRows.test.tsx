import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, fireEvent, within } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/Users/me" }));

import { pointerClick } from "../../test/menus";
import ChatPane from "./panes/ChatPane/ChatPane";
import { loadWorkspaceSettings, settings } from "./settingsStore";
import { unstubbed } from "../../test/settingsBackend";
import { OPEN_JOB, onWith, type OpenJob } from "../../utils/events";
import { runExitEffects } from "../../utils/jobExit";

const voice = { installed: true, espeak: false, brew: true };

const VOICES = [
  { id: "af_heart", name: "Heart", language: "en-US" },
  { id: "am_michael", name: "Michael", language: "en-US" },
  { id: "bf_emma", name: "Emma", language: "en-GB" },
];

beforeEach(async () => {
  Object.assign(voice, { installed: true, espeak: false, brew: true });
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "set_settings") return args.settings;
    if (cmd === "speech_status")
      return {
        installed: voice.installed,
        model: voice.installed ? "int8" : null,
        downloading: null,
        sizes: [{ id: "int8", bytes: 106_987_333 }],
        espeak: voice.espeak,
        brew: voice.brew,
      };
    if (cmd === "speech_delete") voice.installed = false;
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

  it("shows the downloaded size with Delete, and offers Download once it is gone", async () => {
    render(() => <ChatPane {...paneProps} />);
    expect(await screen.findByText("Smaller, 107 MB")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("dialog");
    expect(invoke).not.toHaveBeenCalledWith("speech_delete");
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await macrotask();
    expect(invoke).toHaveBeenCalledWith("speech_delete");
    expect(await screen.findByText("Not downloaded")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Hear this voice" })).toBeNull();
  });

  it("installs espeak-ng through Homebrew in a terminal, then offers Uninstall once the job exits", async () => {
    const jobs: OpenJob[] = [];
    const off = onWith<OpenJob>(OPEN_JOB, (j) => jobs.push(j));
    render(() => <ChatPane {...paneProps} />);
    expect(await screen.findByText("Words Tori does not know are spelled out")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Install espeak-ng" }));
    await macrotask();
    expect(jobs[0]).toMatchObject({ program: "brew", args: ["install", "espeak-ng"], cwd: "/Users/me" });

    voice.espeak = true;
    await runExitEffects(jobs[0], 0);
    fireEvent.click(await screen.findByRole("button", { name: "Uninstall" }));
    await macrotask();
    expect(jobs[1]).toMatchObject({ program: "brew", args: ["uninstall", "espeak-ng"], recheckSpeechOnExit: true });
    off();
  });

  it("names espeak-ng with no button when Homebrew is missing", async () => {
    voice.brew = false;
    render(() => <ChatPane {...paneProps} />);
    expect(await screen.findByText(/spelled out\. Install espeak-ng to fix that\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install espeak-ng" })).toBeNull();
  });
});
