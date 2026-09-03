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
import { OPEN_JOB, type OpenJob } from "../../../../utils/events";
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
function openedJobs(): OpenJob[] {
  const seen: OpenJob[] = [];
  window.addEventListener(OPEN_JOB, (e) => seen.push((e as CustomEvent<OpenJob>).detail));
  return seen;
}

describe("installing an agent from its detail page", () => {
  beforeEach(() => invoked.mockReset());

  it("starts a job running the vendor's documented command", async () => {
    const tabs = openedJobs();
    const { getByText } = await open(mount());
    fireEvent.click(getByText("Install"));
    await waitFor(() => expect(tabs.length).toBe(1));
    expect(tabs[0].program).toBe("npm");
    expect(tabs[0].args).toEqual(["install", "-g", "@github/copilot"]);
    // Installers prompt, so the keyboard has to reach this one when it opens.
    expect(tabs[0].interactive).toBe(true);
    // A finished install has to flip the card to Ready without a restart.
    expect(tabs[0].recheckAgentsOnExit).toBe(true);
    // Per adapter, not per press: a second press reveals the install already
    // running rather than racing two package managers.
    expect(tabs[0].id).toBe("install:copilot");
  });

  // No [install] table means instructions, never a guessed package manager.
  // Said in the step itself rather than behind a button: a button whose only
  // outcome is a sentence would be a control pretending to be an action.
  it("explains instead of guessing when the adapter declares no command", async () => {
    const tabs = openedJobs();
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

  const installedCopilot = { status: "versionUnknown", path: "/usr/bin/copilot", version: "1.2.0" };

  // Offered whenever it is declared and there is a binary to move: not gated
  // on version drift, which is the steady state of every fast-shipping vendor
  // and deliberately never painted as a warning anywhere in the app.
  it("offers the vendor's update for any installed agent that declares one", async () => {
    const tabs = openedJobs();
    const r = await open(mount({ health: installedCopilot, update: NPM_UPDATE }));
    await waitFor(() => expect(r.container.textContent).toContain("Ready"));

    fireEvent.click(r.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(tabs.length).toBe(1));
    expect(tabs[0].id).toBe("update:copilot");
    expect(tabs[0].program).toBe("npm");
    expect(tabs[0].args).toEqual(["install", "-g", "@github/copilot"]);
    expect(tabs[0].recheckAgentsOnExit).toBe(true);
  });

  it("offers no update where none is declared", async () => {
    const r = await open(mount({ health: installedCopilot }));
    await waitFor(() => expect(r.container.textContent).toContain("Ready"));
    expect(r.queryByRole("button", { name: "Update" })).toBeNull();
  });

  // Drift has a direction, and only one of them speaks. Newer than the
  // measurement is the steady state of a fast-shipping vendor, so the page
  // reads exactly like a current install; the bookkeeping stays in
  // ADAPTERS.md.
  it("stays quiet about a binary newer than the measurement", async () => {
    const r = await open(
      mount({
        health: { ...installedCopilot, status: "versionDrift", verifiedAgainst: "copilot 1.0.80" },
        update: NPM_UPDATE,
      }),
    );
    await waitFor(() => expect(r.container.textContent).toContain("Ready"));
    expect(r.container.textContent).not.toContain("Update available");
    expect(r.container.textContent).not.toContain("copilot 1.0.80");
    // The update stays what it always is: a tool in its own section.
    expect(r.getByRole("button", { name: "Update" })).toBeTruthy();
  });

  // Older than the measurement means a newer release provably exists: that
  // earns the banner, carrying both versions and the vendor's update.
  it("offers the update in a banner when the binary is behind the measurement", async () => {
    const tabs = openedJobs();
    const r = await open(
      mount({
        health: {
          ...installedCopilot,
          version: "1.0.0",
          status: "versionDrift",
          verifiedAgainst: "copilot 1.2.0",
        },
        update: NPM_UPDATE,
      }),
    );
    await waitFor(() => expect(r.container.textContent).toContain("Update available"));
    expect(r.container.textContent).toContain("1.0.0");
    expect(r.container.textContent).toContain("1.2.0");

    // One Update control on the page: the banner's. The standalone section
    // yields rather than repeating the button.
    fireEvent.click(r.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(tabs.length).toBe(1));
    expect(tabs[0].id).toBe("update:copilot");
    expect(tabs[0].recheckAgentsOnExit).toBe(true);
  });

  it("says a newer release exists even when no update command is declared", async () => {
    const r = await open(
      mount({
        health: {
          ...installedCopilot,
          version: "1.0.0",
          status: "versionDrift",
          verifiedAgainst: "copilot 1.2.0",
        },
      }),
    );
    await waitFor(() => expect(r.container.textContent).toContain("Update available"));
    expect(r.queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("uninstalls through the vendor's removal command", async () => {
    const tabs = openedJobs();
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
