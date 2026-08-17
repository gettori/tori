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
import { OPEN_TERMINAL, type OpenTerminal } from "../../../../utils/events";
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
const NPM_UPDATE: InstallRoute = {
  type: "terminal",
  program: "npm",
  args: ["install", "-g", "@github/copilot"],
};
const NPM_UNINSTALL: InstallRoute = {
  type: "terminal",
  program: "npm",
  args: ["uninstall", "-g", "@github/copilot"],
};

function mount(
  over: {
    health?: Record<string, unknown>;
    route?: InstallRoute;
    update?: InstallRoute;
    uninstall?: InstallRoute;
  } = {},
) {
  invoked.mockReset();
  invoked.mockImplementation(async (cmd: string) => {
    if (cmd === "agent_health") return [health(over.health)];
    if (cmd === "agent_install_route") return over.route ?? NPM;
    if (cmd === "agent_update_route") return over.update ?? { type: "undeclared" };
    if (cmd === "agent_uninstall_route") return over.uninstall ?? { type: "undeclared" };
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
  // Said in the step itself rather than behind a button: a button whose only
  // outcome is a sentence would be a control pretending to be an action.
  it("explains instead of guessing when the adapter declares no command", async () => {
    const tabs = openedTabs();
    const { container, queryByText } = await open(mount({ route: { type: "undeclared" } }));
    await waitFor(() => expect(container.textContent).toContain("no install command"));
    expect(container.textContent).toContain("copilot");
    expect(queryByText("Install")).toBeNull();
    expect(tabs.length).toBe(0);
  });

  // The steps are the page's plan, and their claims are checkable: the
  // vendor's command is on screen before the button that runs it, the counter
  // counts only what is done, and the later steps wait rather than vanish.
  it("shows the command, the counter, and the waiting steps before anything is done", async () => {
    const { container, getByText } = await open(mount());
    await waitFor(() =>
      expect(container.textContent).toContain("npm install -g @github/copilot"),
    );
    expect(container.textContent).toContain("0 of 3");
    expect(getByText("copy")).toBeTruthy();
    expect(container.textContent).toContain("Available once the binary is installed.");
    expect(container.textContent).toContain("Ready for chat");
  });

  it("offers no install button for an agent that is already installed", async () => {
    const { container, queryByText } = await open(
      mount({ health: { status: "versionUnknown", path: "/usr/bin/copilot", version: "1.0.80" } }),
    );
    await waitFor(() => expect(container.textContent).toContain("Ready"));
    expect(queryByText("Install")).toBeNull();
  });
});

// The other two verbs the [install] table can carry, on the same posture:
// vendor command, visible tab, re-probe on exit, and nothing offered where
// nothing was declared.
describe("updating and uninstalling", () => {
  beforeEach(() => invoked.mockReset());

  const drifted = {
    status: "versionDrift",
    path: "/usr/bin/copilot",
    version: "1.2.0",
    verifiedAgainst: "copilot 1.0.80",
  };

  // Drift's banner carries the next step when the adapter declares one.
  it("offers the vendor's update from the drift banner", async () => {
    const tabs = openedTabs();
    const r = await open(mount({ health: drifted, update: NPM_UPDATE }));
    await waitFor(() => expect(r.container.textContent).toContain("Version drift"));
    // Both versions are named: without them drift is a worry with no content.
    expect(r.container.textContent).toContain("copilot 1.0.80");
    expect(r.container.textContent).toContain("1.2.0");

    fireEvent.click(r.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(tabs.length).toBe(1));
    expect(tabs[0].id).toBe("update:copilot");
    expect(tabs[0].program).toBe("npm");
    expect(tabs[0].args).toEqual(["install", "-g", "@github/copilot"]);
    expect(tabs[0].recheckAgentsOnExit).toBe(true);
  });

  it("shows the drift banner without an update button when none is declared", async () => {
    const r = await open(mount({ health: drifted }));
    await waitFor(() => expect(r.container.textContent).toContain("Version drift"));
    expect(r.queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("uninstalls through the vendor's removal command", async () => {
    const tabs = openedTabs();
    const r = await open(
      mount({
        health: { status: "versionUnknown", path: "/usr/bin/copilot", version: "1.0.80" },
        uninstall: NPM_UNINSTALL,
      }),
    );
    await waitFor(() => expect(r.container.textContent).toContain("Ready"));
    fireEvent.click(r.getByRole("button", { name: "Uninstall" }));
    await waitFor(() => expect(tabs.length).toBe(1));
    expect(tabs[0].id).toBe("uninstall:copilot");
    expect(tabs[0].args).toEqual(["uninstall", "-g", "@github/copilot"]);
    expect(tabs[0].recheckAgentsOnExit).toBe(true);
  });

  // A binary that is not there cannot be removed, however good the command.
  it("offers no uninstall for an agent that is not installed", async () => {
    const r = await open(mount({ uninstall: NPM_UNINSTALL }));
    await waitFor(() => expect(r.container.textContent).toContain("0 of 3"));
    expect(r.queryByRole("button", { name: "Uninstall" })).toBeNull();
  });
});
