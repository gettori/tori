import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();
const backend = vi.hoisted(() => ({ installed: false }));
const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string, _args?: unknown): Promise<unknown> => {
    if (cmd === "speech_speak") {
      if (!backend.installed) throw { kind: "notDownloaded" };
      return 1;
    }
    if (cmd === "speech_status")
      return {
        installed: backend.installed,
        model: backend.installed ? "int8" : null,
        downloading: null,
        sizes: [
          { id: "int8", bytes: 106_987_333 },
          { id: "full", bytes: 340_158_449 },
        ],
      };
    return undefined;
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, h: Handler) => {
    handlers.set(name, h);
    return () => {};
  },
}));
vi.mock("../../panels/Settings/settingsStore", () => ({
  settings: { speech: { rate: 1, voice: null } },
  saveSettings: async () => {},
}));

const { read, stop } = await import("../../utils/speech");
const { closeDialog } = await import("../../utils/voiceDownload");
const { default: VoiceDownloadDialog } = await import("./VoiceDownloadDialog");

const landed = () => {
  backend.installed = true;
  handlers.get("speech-download")?.({ payload: { kind: "done", size: "int8" } });
};
const spoken = () =>
  invoke.mock.calls.filter(([cmd]) => cmd === "speech_speak").map(([, a]) => a as { chunks: string[] });
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  backend.installed = false;
  await stop();
  closeDialog();
  invoke.mockClear();
  render(() => <VoiceDownloadDialog />);
});

describe("the voice download dialog", () => {
  it("opens on a read with no voice, offers the smaller size first, and reads once it lands", async () => {
    await read([{ text: "a reply" }], "r1");
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Smaller, 107 MB/ }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await settled();
    expect(invoke).toHaveBeenCalledWith("speech_download", { size: "int8" });

    landed();
    await settled();
    expect(spoken().map((a) => a.chunks)).toEqual([["a reply"], ["a reply"]]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("downloads the larger size when picked", async () => {
    await read([{ text: "a reply" }], "r1");
    fireEvent.click(await screen.findByRole("radio", { name: /Larger, 340 MB/ }));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await settled();
    expect(invoke).toHaveBeenCalledWith("speech_download", { size: "full" });
  });

  it("drops the waiting read when the dialog is closed, and the download carries on", async () => {
    await read([{ text: "a reply" }], "r1");
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await settled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("speech_download_cancel");

    landed();
    await settled();
    expect(spoken()).toHaveLength(1);
  });

  it("drops the waiting read when a newer read starts first", async () => {
    await read([{ text: "the old one" }], "r1");
    await screen.findByRole("dialog");
    backend.installed = true;
    await read([{ text: "the new one" }], "r2");

    landed();
    await settled();
    expect(spoken().map((a) => a.chunks)).toEqual([["the old one"], ["the new one"]]);
  });

  it("shows progress, then an error with Retry", async () => {
    await read([{ text: "a reply" }], "r1");
    await screen.findByRole("dialog");
    handlers.get("speech-download")?.({ payload: { kind: "progress", size: "int8", done: 40e6, total: 107e6 } });
    expect((await screen.findByRole("status")).textContent).toBe("Downloading, 40 of 107 MB");

    handlers.get("speech-download")?.({ payload: { kind: "error", error: "connection reset" } });
    expect((await screen.findByRole("alert")).textContent).toContain("connection reset");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
