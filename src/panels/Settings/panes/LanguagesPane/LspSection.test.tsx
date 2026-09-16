import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@solidjs/testing-library";
import type { LspHealth } from "./LspSection";

// What the language-server cards must say, driven through the real component.
//
// The one worth the most attention is a **bundled server whose entry script is
// missing**. Its interpreter (`node`) resolves fine, so a card built from the
// program probe alone would read "installed" while every start failed. The
// card has to name the real problem, and must not tell the user to install
// node, which they plainly already have.

let health: LspHealth[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => (cmd === "lsp_health" ? Promise.resolve(health) : Promise.resolve(null)),
}));

const { default: LspSection } = await import("./LspSection");

const server = (over: Partial<LspHealth> = {}): LspHealth => ({
  id: "typescript",
  label: "TypeScript / JavaScript",
  program: "node",
  status: "versionUnknown",
  path: "/usr/bin/node",
  version: "22.22.3",
  verifiedAgainst: null,
  extensions: ["ts", "tsx"],
  detail: null,
  overridePath: null,
  ...over,
});

beforeEach(() => {
  cleanup();
  health = [];
});

describe("LspSection", () => {
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
    health = [server({ id: "rust", label: "Rust", program: "rust-analyzer", status: "notFound", path: null, version: null })];
    render(() => <LspSection />);

    await waitFor(() => expect(screen.getByText(/Not installed\./)).toBeTruthy());
  });

  it("reports a version-less install as installed, not as a problem", async () => {
    health = [server({ version: null, path: "/usr/bin/node" })];
    render(() => <LspSection />);

    // Neither bundled config declares a `verified_against`, so this is the
    // common case and must read neutrally rather than as a warning.
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

    await waitFor(() =>
      expect(screen.getByText(/\/home\/me\/.config\/tori\/lsp\/typescript.toml/)).toBeTruthy(),
    );
  });
});
