import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, cleanup, fireEvent } from "@solidjs/testing-library";
import type { CatalogRow, InstallNext } from "../../utils/packs";

let calls: [string, unknown][] = [];
let resolved: CatalogRow | Error;
let next: InstallNext = { step: "nothing" };

const row = (over: Partial<CatalogRow["pack"]> = {}): CatalogRow => ({
  pack: {
    kind: "themes",
    id: "nord",
    role: null,
    label: "Nord",
    description: "Cool blues",
    contributor: { name: "Ada", github: "ada" },
    license: "MIT",
    verified_against: null,
    verified_on: null,
    platforms: ["linux", "macos", "windows"],
    ...over,
  },
  installed: false,
  bundled: false,
  updateAvailable: false,
  customFile: false,
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    calls.push([cmd, args]);
    if (cmd === "packs_resolve")
      return resolved instanceof Error ? Promise.reject(resolved) : Promise.resolve(resolved);
    if (cmd === "packs_install") return Promise.resolve(next);
    return Promise.resolve(null);
  },
}));

const { default: PackInstallDialog } = await import("./PackInstallDialog");
const { requestPackInstall, dismissPackInstall } = await import("../../utils/packInstall");

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
const installButton = () => screen.getByRole("button", { name: "Install" }) as HTMLButtonElement;
const installs = () => calls.filter(([cmd]) => cmd === "packs_install");

async function open(kind: CatalogRow["pack"]["kind"] = "themes", id = "nord") {
  render(() => <PackInstallDialog />);
  requestPackInstall({ kind, id, origin: "link" });
  await waitFor(() => screen.getByRole("dialog"));
  await frame();
}

beforeEach(() => {
  cleanup();
  dismissPackInstall();
  calls = [];
  resolved = row();
  next = { step: "nothing" };
});

describe("PackInstallDialog", () => {
  it("opens on Cancel, and Enter installs nothing", async () => {
    await open();
    await waitFor(() => expect(installButton().disabled).toBe(false));

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect(fireEvent.keyDown(document.activeElement!, { key: "Enter" })).toBe(false);
    installButton().focus();
    expect(fireEvent.keyDown(installButton(), { key: "Enter" })).toBe(false);

    expect(installs()).toEqual([]);
  });

  it("installs the pack by kind and id when Install is pressed", async () => {
    await open();
    await waitFor(() => expect(installButton().disabled).toBe(false));

    fireEvent.click(installButton());

    await waitFor(() => expect(installs()).toEqual([["packs_install", { kind: "themes", id: "nord" }]]));
  });

  it("says what comes next for a theme, a managed server and a hint", async () => {
    const endings: [CatalogRow["pack"]["kind"], InstallNext, RegExp][] = [
      ["themes", { step: "nothing" }, /Pick it under Settings, Appearance/],
      ["lsp", { step: "managed" }, /Tori offers to install the server/],
      [
        "lsp",
        {
          step: "hint",
          text: "Install it with `dotnet tool install --global csharp-ls`.",
          command: "dotnet tool install --global csharp-ls",
        },
        /comes from its own toolchain/,
      ],
    ];
    for (const [kind, ending, copy] of endings) {
      cleanup();
      dismissPackInstall();
      resolved = row({ kind });
      next = ending;
      await open(kind);
      await waitFor(() => expect(installButton().disabled).toBe(false));

      fireEvent.click(installButton());

      await waitFor(() => screen.getByText(copy));
      expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
      expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    }
    expect(screen.getByText("dotnet tool install --global csharp-ls")).toBeTruthy();
  });

  it("drops a second request while one is open, with a toast", async () => {
    const toasts: string[] = [];
    const toast = (e: Event) => toasts.push((e as CustomEvent<{ message: string }>).detail.message);
    window.addEventListener("tori:toast", toast);
    await open();

    const taken = requestPackInstall({
      kind: "lsp",
      id: "csharp",
      origin: "editor",
    });
    window.removeEventListener("tori:toast", toast);

    expect(taken).toBe(false);
    expect(toasts).toEqual(["Finish the open pack install before csharp."]);
    expect(calls.filter(([cmd]) => cmd === "packs_resolve")).toHaveLength(1);
  });
});
