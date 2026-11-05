import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

const rows = [
  {
    pack: { kind: "dap", id: "debugpy", label: "Python", languages: ["py"] },
    installed: false,
    bundled: false,
    customFile: false,
  },
  {
    pack: { kind: "formatters", id: "gofmt", label: "gofmt", extensions: ["go"] },
    installed: false,
    bundled: false,
    customFile: false,
  },
  { pack: { kind: "themes", id: "dracula", label: "Dracula" }, installed: false, bundled: false, customFile: false },
  { pack: { kind: "lsp", id: "typescript", extensions: ["ts"] }, installed: false, bundled: true, customFile: false },
];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd === "packs_catalog") {
      return Promise.resolve({ rows, stale: false, problem: null });
    }
    return Promise.resolve(null);
  },
}));

const { offerPackFor, offerPackById } = await import("./catalogOffers");
const { pendingPackInstall, dismissPackInstall } = await import("./packInstall");

beforeEach(() => dismissPackInstall());

describe("catalog offers", () => {
  it("F5 on a .py file with no debugger loaded opens the dialog for debugpy", async () => {
    expect(await offerPackFor("dap", "/proj/main.py", "editor")).toBe(true);
    expect(pendingPackInstall()).toEqual({ kind: "dap", id: "debugpy", origin: "editor" });
  });

  it("Format on a .go file with no formatter loaded opens the dialog for gofmt", async () => {
    expect(await offerPackFor("formatters", "/proj/main.go", "editor")).toBe(true);
    expect(pendingPackInstall()).toEqual({ kind: "formatters", id: "gofmt", origin: "editor" });
  });

  it("a selected theme that left the bundle opens the dialog for its pack, as an upgrade", async () => {
    expect(await offerPackById("themes", "dracula", "upgrade")).toBe(true);
    expect(pendingPackInstall()).toEqual({ kind: "themes", id: "dracula", origin: "upgrade" });
  });
});
