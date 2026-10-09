import { describe, it, expect, vi, beforeEach, onTestFinished } from "vite-plus/test";
import { render, screen, waitFor, cleanup, fireEvent } from "@solidjs/testing-library";
import type { LspHealth } from "./LspSection";
import type { Catalog, CatalogRow, LoadError } from "../../../../utils/packs";

// What the language-server cards must say, driven through the real component.
//
// The one worth the most attention is a **bundled server whose entry script is
// missing**. Its interpreter (`node`) resolves fine, so a card built from the
// program probe alone would read "installed" while every start failed. The
// card has to name the real problem, and must not tell the user to install
// node, which they plainly already have.

let health: LspHealth[] = [];
let trusted: string[] = [];
let calls: [string, unknown][] = [];
let loadErrors: LoadError[] = [];
let catalog: Catalog = { rows: [], generatedAt: null, stale: false, problem: null };

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: { path?: string }) => {
    calls.push([cmd, args]);
    if (cmd === "lsp_health") return Promise.resolve(health);
    if (cmd === "trusted_projects") return Promise.resolve(trusted);
    if (cmd === "packs_load_errors") return Promise.resolve(loadErrors);
    if (cmd === "packs_catalog") return Promise.resolve(catalog);
    if (cmd === "revoke_project") trusted = trusted.filter((p) => p !== args?.path);
    return Promise.resolve(null);
  },
}));

type Handler = (e: { payload: unknown }) => void;
let handlers: { name: string; fn: Handler }[] = [];
const emit = (name: string, payload: unknown) =>
  handlers.filter((h) => h.name === name).forEach((h) => h.fn({ payload }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: Handler) => {
    const entry = { name, fn };
    handlers.push(entry);
    return Promise.resolve(() => (handlers = handlers.filter((h) => h !== entry)));
  },
}));

const { default: LspSection } = await import("./LspSection");
const { default: TrustedProjects } = await import("./TrustedProjects");

const server = (over: Partial<LspHealth> = {}): LspHealth => ({
  id: "typescript",
  label: "TypeScript / JavaScript",
  role: "primary",
  program: "node",
  status: "versionUnknown",
  path: "/usr/bin/node",
  version: "22.22.3",
  verifiedAgainst: null,
  verifiedOn: null,
  description: null,
  contributor: null,
  license: null,
  extensions: ["ts", "tsx"],
  detail: null,
  overridePath: null,
  disabled: false,
  disabledByWorkspace: false,
  activationMarkers: [],
  runsPerProject: false,
  hint: null,
  availableVersion: null,
  installedVersion: null,
  update: null,
  uninstall: null,
  provenance: { source: "bundled", updateAvailable: false, catalogConflict: false },
  ...over,
});

const pyright = (over: Partial<LspHealth> = {}) =>
  server({
    id: "python",
    label: "Python (pyright)",
    program: "pyright-langserver",
    status: "notFound",
    path: null,
    version: null,
    extensions: ["py", "pyi"],
    availableVersion: "1.1.414",
    ...over,
  });

beforeEach(() => {
  cleanup();
  health = [];
  trusted = [];
  calls = [];
  loadErrors = [];
  catalog = { rows: [], generatedAt: null, stale: false, problem: null };
});

const row = (id: string, over: Partial<CatalogRow> = {}, pack: Partial<CatalogRow["pack"]> = {}): CatalogRow => ({
  pack: {
    kind: "lsp",
    id,
    role: "primary",
    label: `Pack ${id}`,
    description: `The ${id} server`,
    contributor: { name: "Ada", github: "ada" },
    license: "MIT",
    verified_against: "1.0.0",
    verified_on: "2026-10-01",
    platforms: ["macos"],
    ...pack,
  },
  installed: false,
  bundled: false,
  updateAvailable: false,
  customFile: false,
  ...over,
});

const openAddList = async () => {
  fireEvent.click(await waitFor(() => screen.getByText("Add a language")));
};

describe("LspSection", () => {
  it("shows a server added to the packs folder once the folder is reloaded", async () => {
    health = [server()];
    render(() => <LspSection />);
    await waitFor(() => expect(screen.getByText("TypeScript / JavaScript")).toBeTruthy());

    health = [server(), server({ id: "mine", label: "Mine" })];
    emit("packs:changed", "dap");
    await Promise.resolve();
    expect(screen.queryByText("Mine")).toBeNull();
    emit("packs:changed", "lsp");
    await waitFor(() => expect(screen.getByText("Mine")).toBeTruthy());
  });

  it("labels every card with where its server came from", async () => {
    const from = (source: "bundled" | "catalog" | "override" | "custom") => ({
      source,
      updateAvailable: false,
      catalogConflict: false,
    });
    health = [
      server({ id: "a", label: "A", provenance: from("bundled") }),
      server({ id: "b", label: "B", provenance: from("catalog"), contributor: { name: "Ada", github: "ada" } }),
      server({ id: "c", label: "C", provenance: from("override") }),
      server({ id: "d", label: "D", provenance: from("custom") }),
    ];
    render(() => <LspSection />);

    await waitFor(() => expect(screen.getByText("Bundled")).toBeTruthy());
    expect(screen.getByText("Catalog, by Ada")).toBeTruthy();
    expect(screen.getByText("Override")).toBeTruthy();
    expect(screen.getByText("Custom")).toBeTruthy();
  });

  it("deletes a recorded file that was edited since, from the Needs fixing list", async () => {
    loadErrors = [
      {
        kind: "lsp",
        file: "/cfg/packs/lsp/fresh.toml",
        message: "changed",
        fix: "restore it",
        removable: "fresh",
        restorable: false,
      },
    ];
    render(() => <LspSection />);

    const del = await waitFor(() => screen.getByLabelText("Delete /cfg/packs/lsp/fresh.toml"));
    fireEvent.click(del);
    await waitFor(() => expect(calls).toContainEqual(["packs_remove", { kind: "lsp", id: "fresh" }]));
  });

  it("lists a language server file that did not load, and no other kind's", async () => {
    loadErrors = [
      {
        kind: "lsp",
        file: "/cfg/packs/lsp/typescript.toml",
        message: "bundled id",
        fix: "copy it",
        removable: null,
        restorable: false,
      },
      {
        kind: "dap",
        file: "/cfg/packs/dap/mine.toml",
        message: "broken",
        fix: null,
        removable: null,
        restorable: false,
      },
    ];
    render(() => <LspSection />);

    await waitFor(() => expect(screen.getByText("/cfg/packs/lsp/typescript.toml")).toBeTruthy());
    expect(screen.getByText("Needs fixing")).toBeTruthy();
    expect(screen.getByText("To fix: copy it.")).toBeTruthy();
    expect(screen.queryByText("/cfg/packs/dap/mine.toml")).toBeNull();
  });

  it("renders one card per registered server", async () => {
    health = [server(), server({ id: "rust", label: "Rust", program: "rust-analyzer", extensions: ["rs"] })];
    render(() => <LspSection />);

    await waitFor(() => expect(screen.getByText("TypeScript / JavaScript")).toBeTruthy());
    expect(screen.getByText("Rust")).toBeTruthy();
    // The claimed extensions are the chips, so a user can see at a glance which
    // files this server will actually answer for.
    expect(screen.getByText(".tsx")).toBeTruthy();
    expect(screen.getByText(".rs")).toBeTruthy();
  });

  it("names the real problem for a bundled server whose entry is missing", async () => {
    health = [
      server({
        status: "notFound",
        detail: "the bundled server is not installed (run `pnpm lsp:install`)",
      }),
    ];
    render(() => <LspSection />);

    await waitFor(() => expect(screen.getByText(/pnpm lsp:install/)).toBeTruthy());
    // It must NOT fall through to the generic missing-binary copy, which would
    // tell the user to install node when node is exactly what did resolve.
    expect(screen.queryByText(/Not installed\./)).toBeNull();
  });

  it("tells the user how to fix a genuinely missing server", async () => {
    health = [
      server({ id: "rust", label: "Rust", program: "rust-analyzer", status: "notFound", path: null, version: null }),
    ];
    render(() => <LspSection />);

    await waitFor(() => expect(screen.getByText(/Not installed\./)).toBeTruthy());
  });

  it("reports a version-less install as installed, not as a problem", async () => {
    health = [server({ version: null, path: "/usr/bin/node" })];
    render(() => <LspSection />);

    // Several servers report no version Tori can read (sourcekit-lsp, lemminx),
    // so this must read neutrally rather than as a warning.
    await waitFor(() => expect(screen.getByText(/does not report a version/)).toBeTruthy());
  });

  it("says a language with no server still works", async () => {
    health = [server()];
    render(() => <LspSection />);

    await waitFor(() => expect(screen.getByText(/still opens and edits normally/)).toBeTruthy());
  });

  it("shows which user file overrode a bundled server", async () => {
    health = [server({ overridePath: "/home/me/.config/tori/lsp/typescript.toml" })];
    render(() => <LspSection />);

    await waitFor(() => expect(screen.getByText(/\/home\/me\/.config\/tori\/lsp\/typescript.toml/)).toBeTruthy());
  });

  it("says a server named in lsp.disabled is disabled", async () => {
    health = [server({ disabled: true })];
    render(() => <LspSection />);

    await waitFor(() => expect(screen.getByText(/Disabled by/)).toBeTruthy());
  });

  it("calls a marker-activated server per project, not missing, when its binary is not on PATH", async () => {
    health = [
      server({
        id: "deno",
        label: "Deno",
        program: "deno",
        status: "notFound",
        path: null,
        version: null,
        activationMarkers: ["deno.json", "deno.jsonc"],
      }),
    ];
    render(() => <LspSection />);

    await waitFor(() => expect(screen.getByText(/Runs per project/)).toBeTruthy());
    expect(screen.getByText("deno.json, deno.jsonc")).toBeTruthy();
    expect(screen.queryByText(/Not installed/)).toBeNull();
  });

  it("calls a server launched from the project's own install per project, not missing", async () => {
    health = [
      server({
        id: "biome",
        label: "Biome",
        program: "biome",
        status: "notFound",
        path: null,
        version: null,
        runsPerProject: true,
      }),
    ];
    render(() => <LspSection />);

    await waitFor(() => expect(screen.getByText(/Runs per project, from the project's own/)).toBeTruthy());
    expect(screen.queryByText(/Not installed/)).toBeNull();
  });

  it("offers Install for a server Tori can install, and asks again for health once it is in", async () => {
    health = [pyright()];
    render(() => <LspSection />);

    const install = await screen.findByRole("button", { name: "Install Python (pyright)" });
    expect(screen.getByText(/Available, not installed/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();

    health = [
      pyright({
        status: "versionUnknown",
        path: "/p/pyright-langserver",
        version: "1.1.414",
        installedVersion: "1.1.414",
      }),
    ];
    install.click();

    await waitFor(() => expect(screen.getByText(/Installed by Tori, version 1.1.414\./)).toBeTruthy());
    expect(calls).toContainEqual(["lsp_install", { serverId: "python" }]);
    expect(calls.filter(([cmd]) => cmd === "lsp_health")).toHaveLength(2);
  });

  it("offers Remove, and no Update, for a current install", async () => {
    health = [
      pyright({
        status: "versionUnknown",
        path: "/p/pyright-langserver",
        version: "1.1.414",
        installedVersion: "1.1.414",
      }),
    ];
    render(() => <LspSection />);

    const remove = await screen.findByRole("button", { name: "Remove Python (pyright)" });
    expect(screen.queryByRole("button", { name: /^(Update|Install) / })).toBeNull();

    remove.click();
    await waitFor(() => expect(calls).toContainEqual(["lsp_uninstall", { serverId: "python" }]));
  });

  it("offers Update beside Remove when Tori now pins a newer version", async () => {
    health = [
      pyright({
        status: "versionUnknown",
        path: "/p/pyright-langserver",
        version: "1.1.400",
        installedVersion: "1.1.400",
      }),
    ];
    render(() => <LspSection />);

    const update = await screen.findByRole("button", { name: "Update Python (pyright)" });
    expect(screen.getByText(/Version 1.1.414 is available/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Python (pyright)" })).toBeTruthy();

    update.click();
    await waitFor(() => expect(calls).toContainEqual(["lsp_install", { serverId: "python" }]));
  });

  it("lists trusted projects, and Revoke takes one off the list", async () => {
    trusted = ["/work/repo", "/work/other"];
    render(() => <TrustedProjects />);

    const revoke = await screen.findByRole("button", { name: "Revoke /work/repo" });
    revoke.click();

    await waitFor(() => expect(screen.queryByText("/work/repo")).toBeNull());
    expect(screen.getByText("/work/other")).toBeTruthy();
  });

  it("opens the add list by asking the catalog to revalidate, with each row's state", async () => {
    catalog.rows = [
      row("fresh"),
      row("rust", { bundled: true }),
      row("mine", { installed: true }),
      row("old", { installed: true, updateAvailable: true }),
      row("clash", { customFile: true }),
      row("lint", {}, { role: "secondary" }),
    ];
    render(() => <LspSection />);
    await openAddList();

    await waitFor(() => expect(screen.getByText("Pack fresh")).toBeTruthy());
    expect(calls).toContainEqual(["packs_catalog", { forceRevalidate: true }]);
    const card = (id: string) => document.querySelector(`[data-pack="${id}"]`) as HTMLElement;
    expect(card("fresh").textContent).toContain("Install");
    expect(card("fresh").textContent).toContain("By Ada (@ada), MIT");
    expect(card("fresh").textContent).toContain("Verified against 1.0.0 on 2026-10-01");
    expect(card("rust").textContent).toContain("Bundled");
    expect(card("rust").querySelector("button")).toBeNull();
    expect(card("mine").textContent).toContain("Installed");
    expect(card("mine").textContent).toContain("Remove");
    expect(card("old").textContent).toContain("Update available");
    expect(card("old").textContent).toContain("Update");
    expect(card("clash").textContent).toContain("Your custom file uses this id");
    expect(card("clash").textContent).toContain("Rename yours to install this one.");
    expect((card("clash").querySelector("button") as HTMLButtonElement).disabled).toBe(true);
    expect(card("lint")).toBeNull();
  });

  it("shows an installed pack's health card with its contributor", async () => {
    catalog.rows = [row("fresh")];
    render(() => <LspSection />);
    await openAddList();
    fireEvent.click(await waitFor(() => screen.getByText("Install")));
    await waitFor(() => expect(calls).toContainEqual(["packs_install", { kind: "lsp", id: "fresh" }]));

    health = [
      server({
        id: "fresh",
        label: "Fresh",
        contributor: { name: "Ada", github: "ada" },
        provenance: { source: "catalog", updateAvailable: false, catalogConflict: false },
      }),
    ];
    emit("packs:changed", "lsp");
    await waitFor(() => expect(screen.getByText("Fresh")).toBeTruthy());
    expect(screen.getByText("Catalog, by Ada")).toBeTruthy();
  });

  it("says why the catalog is offline, unverified or stale in one neutral line", async () => {
    const toasts: unknown[] = [];
    const toast = (e: Event) => toasts.push(e);
    window.addEventListener("tori:toast", toast);
    onTestFinished(() => window.removeEventListener("tori:toast", toast));
    for (const [problem, text] of [
      [{ kind: "offline", message: "no network" }, "The catalog could not be reached: no network"],
      [{ kind: "unverified", message: "bad sig" }, "The catalog did not verify: bad sig"],
    ] as const) {
      cleanup();
      catalog = { rows: [], generatedAt: null, stale: false, problem };
      render(() => <LspSection />);
      await openAddList();
      await waitFor(() => expect(screen.getByText(text)).toBeTruthy());
    }
    cleanup();
    catalog = { rows: [row("fresh")], generatedAt: "2026-09-01T00:00:00Z", stale: true, problem: null };
    render(() => <LspSection />);
    await openAddList();
    await waitFor(() => expect(screen.getByText("Catalog last refreshed on 2026-09-01.")).toBeTruthy());
    expect(screen.getByText("Install")).toBeTruthy();
    expect(toasts).toEqual([]);
  });

  it("marks a custom server whose id the catalog uses, quietly", async () => {
    const toasts: unknown[] = [];
    const toast = (e: Event) => toasts.push(e);
    window.addEventListener("tori:toast", toast);
    onTestFinished(() => window.removeEventListener("tori:toast", toast));
    health = [server({ id: "mine", provenance: { source: "custom", updateAvailable: false, catalogConflict: true } })];
    render(() => <LspSection />);

    await waitFor(() => expect(screen.getByText(/The catalog also has a pack called/)).toBeTruthy());
    expect(screen.getByText(/Rename yours to install it\./)).toBeTruthy();
    expect(screen.queryByText("Needs fixing")).toBeNull();
    expect(toasts).toEqual([]);
  });

  it("restores an edited catalog pack from the Needs fixing list", async () => {
    loadErrors = [
      {
        kind: "lsp",
        file: "/cfg/packs/lsp/fresh.toml",
        message: "changed",
        fix: "restore it",
        removable: "fresh",
        restorable: true,
      },
    ];
    render(() => <LspSection />);

    fireEvent.click(await waitFor(() => screen.getByLabelText("Restore /cfg/packs/lsp/fresh.toml")));
    await waitFor(() => expect(calls).toContainEqual(["packs_update", { kind: "lsp", id: "fresh" }]));
  });
});
