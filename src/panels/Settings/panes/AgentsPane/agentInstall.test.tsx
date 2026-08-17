// The install half of an agent's detail page, end to end through the component.
//
// Sway never installs anything itself: the button opens a real terminal tab
// running the vendor's own documented command, from the adapter's [install]
// table, and the tab re-probes health on exit. These tests keep that shape:
// nothing here asserts on a package landing anywhere, because nothing does.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import AgentsSection from "./AgentsSection";
import { OPEN_TERMINAL, TOAST, type OpenTerminal, type ToastEvent } from "../../../../utils/events";
import type { InstallRoute } from "../../../../utils/install";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/home/me" }));
const invoked = vi.mocked(invoke);

const health = (over: Record<string, unknown> = {}) => ({
  id: "copilot",
  label: "Copilot",
  program: "copilot",
  status: "notFound",
  signIn: "unknown",
  account: null,
  apiKeySource: null,
  path: null,
  version: null,
  verifiedAgainst: null,
  sessionsDir: null,
  sessionsDirExists: false,
  hooks: false,
  needsYou: false,
  overridePath: null,
  ...over,
});

const NPM: InstallRoute = {
  type: "terminal",
  program: "npm",
  args: ["install", "-g", "@github/copilot"],
};

function mount(over: { health?: Record<string, unknown>; route?: InstallRoute } = {}) {
  invoked.mockReset();
  invoked.mockImplementation(async (cmd: string) => {
    if (cmd === "agent_health") return [health(over.health)];
    if (cmd === "agent_install_route") return over.route ?? NPM;
    if (cmd === "agent_accounts")
      return { adapterId: "copilot", declared: false, canAdd: false, canSignOut: false, profiles: [] };
    return [];
  });
  return render(() => <AgentsSection />);
}

async function open(r: ReturnType<typeof render>) {
  const card = await r.findByRole("button", { name: /Copilot/ });
  fireEvent.click(card);
  await waitFor(() => expect(r.container.textContent).toContain("Chat capabilities"));
  return r;
}

/** Terminal tabs the component asked for, in order. */
function openedTabs(): OpenTerminal[] {
  const seen: OpenTerminal[] = [];
  window.addEventListener(OPEN_TERMINAL, (e) =>
    seen.push((e as CustomEvent<OpenTerminal>).detail),
  );
  return seen;
}

function raisedToasts(): ToastEvent[] {
  const seen: ToastEvent[] = [];
  window.addEventListener(TOAST, (e) => seen.push((e as CustomEvent<ToastEvent>).detail));
  return seen;
}

describe("installing an agent from its detail page", () => {
  beforeEach(() => invoked.mockReset());

  it("opens a terminal tab running the vendor's documented command", async () => {
    const tabs = openedTabs();
    const { getByText } = await open(mount());
    fireEvent.click(getByText("Install"));
    await waitFor(() => expect(tabs.length).toBe(1));
    expect(tabs[0].program).toBe("npm");
    expect(tabs[0].args).toEqual(["install", "-g", "@github/copilot"]);
    // Direct spawn, so the tab stays put on failure and "npm: command not
    // found" is readable rather than a vanished window.
    expect(tabs[0].kind).toBe("command");
    // A finished install has to flip the card to Ready without a restart.
    expect(tabs[0].recheckAgentsOnExit).toBe(true);
    // Per adapter, not per press: a second press focuses the tab already
    // installing rather than racing two package managers.
    expect(tabs[0].id).toBe("install:copilot");
  });

  // No [install] table means instructions, never a guessed package manager.
  it("explains instead of guessing when the adapter declares no command", async () => {
    const tabs = openedTabs();
    const toasts = raisedToasts();
    const { getByText } = await open(mount({ route: { type: "undeclared" } }));
    fireEvent.click(getByText("Install"));
    await waitFor(() => expect(toasts.length).toBe(1));
    expect(toasts[0].message).toContain("no install command");
    expect(toasts[0].message).toContain("copilot");
    expect(tabs.length).toBe(0);
  });

  it("offers no install button for an agent that is already installed", async () => {
    const { container, queryByText } = await open(
      mount({ health: { status: "versionUnknown", path: "/usr/bin/copilot", version: "1.0.80" } }),
    );
    await waitFor(() => expect(container.textContent).toContain("Installed"));
    expect(queryByText("Install")).toBeNull();
  });
});
