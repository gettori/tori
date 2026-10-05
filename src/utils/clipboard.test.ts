import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

const tauriWriteText = vi.fn();
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: (t: string) => tauriWriteText(t) }));

const { copyText } = await import("./clipboard");

const stubWebClipboard = (impl: () => Promise<void>) => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: impl }, configurable: true });
};

describe("copyText", () => {
  beforeEach(() => {
    tauriWriteText.mockReset().mockResolvedValue(undefined);
  });

  it("uses the webview clipboard when it resolves, without touching the plugin", async () => {
    const web = vi.fn().mockResolvedValue(undefined);
    stubWebClipboard(web);
    expect(await copyText("hello")).toBe(true);
    expect(web).toHaveBeenCalledWith("hello");
    expect(tauriWriteText).not.toHaveBeenCalled();
  });

  it("falls back to the Tauri plugin when the webview clipboard rejects", async () => {
    stubWebClipboard(vi.fn().mockRejectedValue(new Error("not allowed")));
    expect(await copyText("hello")).toBe(true);
    expect(tauriWriteText).toHaveBeenCalledWith("hello");
  });

  it("reports failure when both paths reject", async () => {
    stubWebClipboard(vi.fn().mockRejectedValue(new Error("not allowed")));
    tauriWriteText.mockRejectedValue(new Error("no pasteboard"));
    expect(await copyText("hello")).toBe(false);
  });
});
