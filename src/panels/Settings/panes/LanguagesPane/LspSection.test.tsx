import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, cleanup } from "@solidjs/testing-library";
import type { LspHealth } from "./LspSection";
import type { LoadError } from "../../../../utils/packs";

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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: { path?: string }) => {
    calls.push([cmd, args]);
    if (cmd === "lsp_health") return Promise.resolve(health);
    if (cmd === "trusted_projects") return Promise.resolve(trusted);
    if (cmd === "packs_load_errors") return Promise.resolve(loadErrors);
    if (cmd === "revoke_project") trusted = trusted.filter((p) => p !== args?.path);
    return Promise.resolve(null);
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
});

describe("LspSection", () => {
  it("lists a language server file that did not load, and no other kind's", async () => {
    loadErrors = [
      { kind: "lsp", file: "/cfg/packs/lsp/typescript.toml", message: "bundled id", fix: "copy it" },
      { kind: "dap", file: "/cfg/packs/dap/mine.toml", message: "broken", fix: null },
    ];
    render(() => <LspSection />);

    await waitFor(() => expect(screen.getByText("Needs fixing")).toBeTruthy());
    expect(screen.getByText("/cfg/packs/lsp/typescript.toml")).toBeTruthy();
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
});
