import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, cleanup } from "@solidjs/testing-library";

let stored: Record<string, unknown> = {};
let installs: string[] = [];
let failInstall: string | null = null;
let releaseInstall: (() => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "get_settings") {
      const { DEFAULT_SETTINGS } = await import("../Settings/settingsStore");
      return { ...DEFAULT_SETTINGS, ...stored };
    }
    if (cmd === "set_settings") {
      stored = args.settings as Record<string, unknown>;
      return stored;
    }
    if (cmd === "lsp_install") {
      installs.push(args.serverId as string);
      await new Promise<void>((resolve) => (releaseInstall = resolve));
      if (failInstall) throw failInstall;
    }
    if (cmd === "lsp_registry") return registry;
    if (cmd === "packs_catalog") return catalog;
    return null;
  },
}));

const registry = [
  { id: "typescript", label: "TypeScript", languages: { ts: "typescript" }, role: "primary" },
  { id: "csharp", label: "C#", languages: { cs: "csharp" }, role: "primary" },
];
const catalogPack = (id: string, label: string, ext: string) => ({
  pack: { kind: "lsp", id, label, extensions: [ext], platforms: [] },
  installed: false,
  bundled: false,
  updateAvailable: false,
  customFile: false,
});
const catalog = {
  rows: [catalogPack("ruby", "Ruby", "rb"), catalogPack("csharp", "C#", "cs")],
  stale: false,
  problem: null,
};
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { default: InstallBanner } = await import("./InstallBanner");
const { offerInstall, offerFor, onServerInstalled } = await import("../../utils/serverInstall");
const { loadSettings, setServerDisabled } = await import("../Settings/settingsStore");
const { ensureLspServersLoaded } = await import("../../utils/lspServers");
const { pendingPackInstall, dismissPackInstall } = await import("../../utils/packInstall");

// The offers live for the session, so each test asks for its own server.
let seq = 0;
function offered(): { id: string; file: string } {
  seq += 1;
  const id = `server${seq}`;
  const file = `/proj/a${seq}.py`;
  offerInstall(id, "Python (pyright)", file);
  return { id, file };
}

beforeEach(async () => {
  cleanup();
  stored = {};
  installs = [];
  failInstall = null;
  releaseInstall = null;
  await loadSettings();
});

describe("InstallBanner", () => {
  it("Install shows progress, then goes and tells the editor the server arrived", async () => {
    const { id, file } = offered();
    const arrived: string[] = [];
    const off = onServerInstalled((s) => arrived.push(s));
    render(() => <InstallBanner path={file} />);

    screen.getByRole("button", { name: "Install" }).click();
    await waitFor(() => expect(screen.getByText(/Installing Python \(pyright\)/)).toBeTruthy());
    expect(installs).toEqual([id]);

    releaseInstall?.();
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(arrived).toEqual([id]);
    off();
  });

  it("a failed install says why and offers to try again, leaving the offer open", async () => {
    const { id, file } = offered();
    failInstall = "npm install pyright@1.1.414 failed: ENOTFOUND";
    render(() => <InstallBanner path={file} />);

    screen.getByRole("button", { name: "Install" }).click();
    await waitFor(() => expect(installs).toEqual([id]));
    releaseInstall?.();

    await waitFor(() => expect(screen.getByText(/Could not install Python \(pyright\): npm install/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(offerFor(file)?.status).toBe("failed");
  });

  it("offers the catalog pack for a file no loaded server claims, and Get opens the install dialog", async () => {
    await ensureLspServersLoaded();
    render(() => <InstallBanner path="/proj/app.rb" />);

    await waitFor(() => expect(screen.getByText(/language server pack for this file: Ruby/)).toBeTruthy());
    screen.getByRole("button", { name: "Get" }).click();

    expect(pendingPackInstall()).toEqual({ kind: "lsp", id: "ruby", origin: "editor" });
    dismissPackInstall();
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("offers nothing for an extension a loaded server claims, even one switched off", async () => {
    await ensureLspServersLoaded();
    await setServerDisabled("csharp", true);
    render(() => (
      <>
        <InstallBanner path="/proj/app.ts" />
        <InstallBanner path="/proj/app.cs" />
      </>
    ));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Not now drops the offer and does not make it again this session", async () => {
    const { id, file } = offered();
    render(() => <InstallBanner path={file} />);

    screen.getByRole("button", { name: "Not now" }).click();
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());

    offerInstall(id, "Python (pyright)", "/proj/other.py");
    expect(offerFor("/proj/other.py")).toBeNull();
    expect(installs).toEqual([]);
  });

  it("Never is saved to settings and still holds after a restart", async () => {
    const { id, file } = offered();
    render(() => <InstallBanner path={file} />);

    screen.getByRole("button", { name: "Never for this language" }).click();
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    await waitFor(() => expect((stored.lsp as { neverOffer: string[] }).neverOffer).toEqual([id]));

    // What a restart does: settings load from the file, and the session's
    // offers and answers start empty.
    vi.resetModules();
    const fresh = await import("../../utils/serverInstall");
    const store = await import("../Settings/settingsStore");
    const { default: FreshBanner } = await import("./InstallBanner");
    await store.loadSettings();
    fresh.offerInstall(id, "Python (pyright)", file);
    cleanup();
    render(() => <FreshBanner path={file} />);

    expect(fresh.offerFor(file)).not.toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
