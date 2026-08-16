import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent, screen } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import AgentsSection from "./AgentsSection";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invoked = vi.mocked(invoke);

const build = (over: Record<string, unknown> = {}) => ({
  archive: "https://downloads.cursor.com/lab/darwin/arm64/agent-cli-package.tar.gz",
  sha256: null,
  cmd: "./dist-package/cursor-agent",
  args: ["acp"],
  env: {},
  ...over,
});

const row = (over: Record<string, unknown> = {}) => ({
  id: "cursor",
  label: "Cursor",
  description: "Cursor's coding agent",
  registryVersion: "2026.08.11",
  website: "https://cursor.com/docs/cli/acp",
  command: "cursor-agent acp",
  needs: "on-path",
  coveredBy: null,
  build: null,
  noBuildHere: false,
  publishedCapabilities: null,
  ...over,
});

const installed = (over: Record<string, unknown> = {}) => ({
  id: "cursor",
  registryVersion: "2026.08.11",
  platform: "darwin-aarch64",
  archive: "https://downloads.cursor.com/lab/darwin/arm64/agent-cli-package.tar.gz",
  sha256: null,
  program: "/Users/x/Library/Application Support/sway/agents/cursor/dist-package/cursor-agent",
  args: ["acp"],
  env: {},
  quarantineCleared: false,
  installedAt: 1_700_000_000,
  ...over,
});

const source = (over: Record<string, unknown> = {}) => ({
  source: "https://github.com/agentclientprotocol/registry",
  registryCommit: "2dd65dacffffffffffffffffffffffffffffffff",
  generatedOn: "2026-08-14",
  matrixSource: null,
  hostPlatform: "darwin-aarch64",
  ...over,
});

const health = (over: Record<string, unknown> = {}) => ({
  id: "claude",
  label: "Claude",
  program: "claude",
  status: "versionMatch",
  signIn: "unknown",
  account: null,
  apiKeySource: null,
  path: "/usr/bin/claude",
  version: "2.1.231",
  verifiedAgainst: "claude 2.1.231",
  sessionsDir: "/Users/x/.claude/projects",
  sessionsDirExists: true,
  hooks: true,
  needsYou: true,
  overridePath: null,
  ...over,
});

/**
 * The catalogue is a list of agents nobody has run, so every assertion here is
 * about it not looking like the list above it.
 */
describe("the ACP launch catalog in Settings > Agents", () => {
  beforeEach(() => {
    invoked.mockReset();
    invoked.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_health") return [health()];
      if (cmd === "acp_catalog") return [row()];
      if (cmd === "acp_catalog_source") return source();
      return [];
    });
  });

  it("labels every entry untested and shows the command that would start it", async () => {
    const { container } = render(() => <AgentsSection />);
    await waitFor(() => expect(container.textContent).toContain("Cursor"));

    expect(container.textContent).toContain("untested");
    expect(container.textContent).toContain("cursor-agent acp");
    // The one assumption the catalogue makes, said out loud rather than implying
    // Sway will fetch the binary.
    expect(container.textContent).toContain("if you have installed it yourself");
  });

  it("names where the list came from and how to refresh it", async () => {
    const { container } = render(() => <AgentsSection />);
    await waitFor(() => expect(container.textContent).toContain("ACP Registry"));

    // Provenance: a list of unmeasured launch commands with no origin and no
    // date is the thing that rots quietly.
    expect(container.textContent).toContain("agentclientprotocol/registry");
    expect(container.textContent).toContain("2dd65dac");
    expect(container.textContent).toContain("2026-08-14");
    expect(container.textContent).toContain("dev/acp-catalog.mjs");
  });

  it("drops an entry an adapter already covers, rather than offering a second way in", async () => {
    invoked.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_health") return [health()];
      if (cmd === "acp_catalog") {
        return [row({ id: "opencode", label: "OpenCode", command: "opencode acp", coveredBy: "opencode" })];
      }
      if (cmd === "acp_catalog_source") return source({ registryCommit: "abcdef1234" });
      return [];
    });

    const { container } = render(() => <AgentsSection />);
    await waitFor(() => expect(container.textContent).toContain("Claude"));

    // The whole section is gone when every row is covered: a measured harness
    // and an unmeasured launch of the same agent is a downgrade dressed as a
    // choice.
    expect(container.textContent).not.toContain("Other agents that speak ACP");
    expect(container.textContent).not.toContain("untested");
  });

  it("gives a catalog entry no status dot, no version and no capability list", async () => {
    const { container } = render(() => <AgentsSection />);
    await waitFor(() => expect(container.textContent).toContain("Cursor"));

    // One card, for the one adapter. A catalog row is a list item, not a card,
    // so it cannot pick up the affordances a measured harness has earned.
    const cards = container.querySelectorAll("[class*='card']");
    const titles = [...container.querySelectorAll("[class*='hcardName']")].map((n) => n.textContent);
    expect(titles).toEqual(["Claude"]);
    expect(cards.length).toBeGreaterThan(0);

    // And the registry's own pinned version is not presented as a version Sway
    // checked: the row says untested, and nothing on it reads as a match.
    expect(container.textContent).not.toContain("Installed, version 2026.08.11");
  });
});

/**
 * Installing one of these rows, which is the only place in Sway that downloads a
 * binary. Every assertion here is about the user knowing what they agreed to
 * before it happens, and about the row still being an untested entry after.
 */
describe("installing an agent from the catalog", () => {
  const mount = (over: { rows?: unknown[]; installed?: unknown[] } = {}) => {
    invoked.mockReset();
    invoked.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_health") return [health()];
      if (cmd === "acp_catalog") return over.rows ?? [row({ needs: "install", build: build() })];
      if (cmd === "acp_catalog_source") return source();
      if (cmd === "installed_agents") return over.installed ?? [];
      return [];
    });
    return render(() => <AgentsSection />);
  };

  const cmds = () => invoked.mock.calls.map(([c]) => c);

  beforeEach(() => invoked.mockReset());

  /**
   * **The confirm is a real gate, and it states the trust model.** The checksum
   * and the URL come from the same file, so a green tick would be claiming more
   * than the check buys. Nothing is downloaded until the user says so.
   */
  it("says what installing commits the user to, and downloads nothing until they agree", async () => {
    const { container } = mount();
    await waitFor(() => expect(container.textContent).toContain("Cursor"));

    fireEvent.click(screen.getByText("Install"));
    await waitFor(() =>
      expect(screen.getByText("Install Cursor from the ACP Registry?")).toBeTruthy(),
    );
    expect(cmds()).not.toContain("install_agent");

    const body = document.body.textContent ?? "";
    expect(body).toContain("Nothing goes on your PATH");
    expect(body).toContain("trusting the ACP Registry");
    expect(body).toContain("installing one does not change that");

    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByText("Download and install")).toBeNull());
    expect(cmds()).not.toContain("install_agent");
  });

  /** A publisher with no checksum and one with a checksum do not read the same,
   *  because they are not the same guarantee. */
  it("tells a checksummed download apart from one with nothing to check", async () => {
    const { container, unmount } = mount();
    await waitFor(() => expect(container.textContent).toContain("Cursor"));
    fireEvent.click(screen.getByText("Install"));
    await waitFor(() => expect(screen.getByText("Download and install")).toBeTruthy());
    expect(document.body.textContent).toContain("publishes no checksum for this download");
    fireEvent.click(screen.getByText("Cancel"));
    unmount();

    mount({ rows: [row({ needs: "install", build: build({ sha256: "ab".repeat(32) }) })] });
    await waitFor(() => expect(screen.getByText("Install")).toBeTruthy());
    fireEvent.click(screen.getByText("Install"));
    await waitFor(() => expect(screen.getByText("Download and install")).toBeTruthy());
    const body = document.body.textContent ?? "";
    expect(body).toContain("Sway checks the download against it");
    // And it still refuses to claim more than a transport control.
    expect(body).toContain("cannot prove who published them");
  });

  /**
   * **The Gatekeeper bypass is off unless it is asked for, and the sentence the
   * user agrees to says which way it is going.** Clearing that flag is macOS's
   * check being switched off, so it cannot ride along inside "Install".
   */
  it("leaves the quarantine flag alone unless the user ticks the box", async () => {
    const { container } = mount();
    await waitFor(() => expect(container.textContent).toContain("Cursor"));

    fireEvent.click(screen.getByText("Install"));
    await waitFor(() => expect(screen.getByText("Download and install")).toBeTruthy());
    expect(document.body.textContent).toContain("will leave the macOS quarantine flag on");
    fireEvent.click(screen.getByText("Download and install"));
    await waitFor(() => expect(cmds()).toContain("install_agent"));
    expect(
      invoked.mock.calls.find(([c]) => c === "install_agent")?.[1],
    ).toMatchObject({ id: "cursor", allowQuarantineBypass: false });

    invoked.mockClear();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Install"));
    await waitFor(() => expect(screen.getByText("Download and install")).toBeTruthy());
    // Told what it disables, at the moment of agreeing to it.
    expect(document.body.textContent).toContain(
      "the check that would otherwise stop an unnotarized binary from running",
    );
    fireEvent.click(screen.getByText("Download and install"));
    await waitFor(() => expect(cmds()).toContain("install_agent"));
    expect(
      invoked.mock.calls.find(([c]) => c === "install_agent")?.[1],
    ).toMatchObject({ allowQuarantineBypass: true });
  });

  /** Off macOS there is no quarantine flag, so there is no control and no
   *  sentence about one. A checkbox that provably does nothing reads as a choice
   *  being made. */
  it("offers no Gatekeeper control where there is no Gatekeeper", async () => {
    invoked.mockReset();
    invoked.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_health") return [health()];
      if (cmd === "acp_catalog") return [row({ needs: "install", build: build() })];
      if (cmd === "acp_catalog_source") return source({ hostPlatform: "linux-x86_64" });
      return [];
    });
    const { container } = render(() => <AgentsSection />);
    await waitFor(() => expect(container.textContent).toContain("Cursor"));

    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByText("Install"));
    await waitFor(() => expect(screen.getByText("Download and install")).toBeTruthy());
    expect(document.body.textContent).not.toContain("quarantine");
    // The rest of the disclosure is unchanged: the trust model is not a macOS
    // fact.
    expect(document.body.textContent).toContain("trusting the ACP Registry");
  });

  /**
   * **An installed agent is still an untested entry.** It gained a path on disk
   * and nothing else: no tier, no card, no version Sway checked. Conflating the
   * two is the whole failure this list is separated to avoid.
   */
  it("keeps an installed agent labelled untested, and says where it went", async () => {
    const { container } = mount({
      rows: [row({ needs: "install", build: build() })],
      installed: [installed()],
    });
    await waitFor(() => expect(container.textContent).toContain("Installed at"));

    expect(container.textContent).toContain("untested");
    expect(container.textContent).toContain("sway/agents/cursor/dist-package/cursor-agent");
    expect(container.textContent).toContain("Sway has still run nothing");
    expect(container.textContent).toContain("this download was never verified");
    // Still a list item rather than a card, so it cannot pick up the affordances
    // a measured harness earned.
    const titles = [...container.querySelectorAll("[class*='hcardName']")].map((n) => n.textContent);
    expect(titles).toEqual(["Claude"]);
    // And the install button is gone: there is nothing left to install.
    expect(screen.queryByText("Install")).toBeNull();
  });

  it("offers removal of an installed agent and re-reads the list afterwards", async () => {
    const { container } = mount({
      rows: [row({ needs: "install", build: build() })],
      installed: [installed()],
    });
    await waitFor(() => expect(container.textContent).toContain("Installed at"));

    invoked.mockClear();
    fireEvent.click(screen.getByText("Remove"));
    await waitFor(() => expect(cmds()).toContain("remove_installed_agent"));
    expect(invoked.mock.calls.find(([c]) => c === "remove_installed_agent")?.[1]).toMatchObject({
      id: "cursor",
    });
    // Re-read, so the row goes back to offering an install rather than showing a
    // path that is no longer there.
    await waitFor(() => expect(cmds()).toContain("installed_agents"));
  });

  /**
   * **An architecture with no build is said, not hidden.** A row that silently
   * dropped would read as "this agent does not exist"; one that offered any
   * build would hand an Intel Mac an arm64 binary.
   */
  it("says an agent has no build for this machine rather than offering one", async () => {
    const { container } = mount({
      rows: [row({ id: "kimi", label: "Kimi", needs: "install", build: null, noBuildHere: true })],
    });
    await waitFor(() => expect(container.textContent).toContain("Kimi"));

    expect(container.textContent).toContain("No build for darwin-aarch64");
    expect(screen.queryByText("Install")).toBeNull();
  });

  /**
   * **The list is a pinned snapshot, so it says how old it is.** It renders with
   * no network at all, which is the point; without an age, "pinned" reads as
   * "current" and a year-old list looks like today's.
   */
  it("renders offline from the snapshot and states its age", async () => {
    const twelveDaysAgo = new Date(Date.now() - 12 * 86_400_000).toISOString().slice(0, 10);
    invoked.mockReset();
    invoked.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_health") return [health()];
      if (cmd === "acp_catalog") return [row()];
      if (cmd === "acp_catalog_source") return source({ generatedOn: twelveDaysAgo });
      return [];
    });
    const { container } = render(() => <AgentsSection />);
    await waitFor(() => expect(container.textContent).toContain("12 days old"));

    // Everything on screen came from the committed file: the only commands are
    // reads of local state, and none of them fetches anything.
    // `agent_accounts` is absent because accounts moved behind the drill-in:
    // the list asks nothing per harness until one is opened.
    expect([...new Set(cmds())].sort()).toEqual([
      "acp_catalog",
      "acp_catalog_source",
      "agent_health",
      "installed_agents",
    ]);
    expect(container.textContent).toContain("2dd65dac");
  });

  /** Capabilities on a row are the registry's probe, named as such. A tier is
   *  Sway's own and lives on the cards above. */
  it("names the registry as the prober behind any published capabilities", async () => {
    invoked.mockReset();
    invoked.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_health") return [health()];
      if (cmd === "acp_catalog") return [row()];
      if (cmd === "acp_catalog_source")
        return source({
          matrixSource: {
            source: "https://github.com/agentclientprotocol/registry/blob/main/.protocol-matrix/latest.json",
            probedOn: "2026-08-14",
            agentsProbed: 31,
          },
        });
      return [];
    });
    const { container } = render(() => <AgentsSection />);
    await waitFor(() => expect(container.textContent).toContain("the registry's own probe"));
    expect(container.textContent).toContain("31 agents");
    expect(container.textContent).toContain("not from anything Sway measured");
  });
});

/**
 * Every non-ready state gets one action, so none of them is a row the user can
 * only read. The action is "check again" rather than "install for me": Phase 5
 * owns fetching from the registry, and a button that installed nothing would be
 * the dead entry this exists to remove.
 */
describe("the action on a non-ready agent card", () => {
  beforeEach(() => {
    invoked.mockReset();
    invoked.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_health") return [health({ status: "notFound", path: null, version: null })];
      if (cmd === "refresh_agent_health")
        return [health({ status: "notFound", path: null, version: null })];
      if (cmd === "acp_catalog") return [];
      if (cmd === "acp_catalog_source") return null;
      return undefined;
    });
  });

  /** Opens the harness's own page, where every action now lives. */
  const openCard = async (r: ReturnType<typeof render>) => {
    fireEvent.click(await r.findByRole("button", { name: /Claude/ }));
    await waitFor(() => expect(r.container.textContent).toContain("Chat capabilities"));
    return r;
  };

  it("offers a re-probe on a missing binary, and stops telling the user to restart", async () => {
    const { container, getByText } = await openCard(render(() => <AgentsSection />));
    await waitFor(() => expect(container.textContent).toContain("Not installed"));

    // The old copy said "reopen Sway to pick it up", which stopped being true
    // when the health sweep became invalidatable.
    expect(container.textContent).not.toContain("reopen Sway");
    getByText("Check again");
  });

  it("re-probes through the refresh command rather than re-reading the cache", async () => {
    const { container, getByText } = await openCard(render(() => <AgentsSection />));
    await waitFor(() => expect(container.textContent).toContain("Not installed"));

    invoked.mockClear();
    fireEvent.click(getByText("Check again"));

    await waitFor(() =>
      expect(invoked.mock.calls.some(([cmd]) => cmd === "refresh_agent_health")).toBe(true),
    );
  });

  // The card carries no action at all now, healthy or not: it is a summary, and
  // a grid of buttons is the thing that made the old one unreadable.
  it("keeps every action off the card and on the harness's own page", async () => {
    invoked.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_health") return [health()];
      if (cmd === "acp_catalog") return [];
      if (cmd === "acp_catalog_source") return null;
      return undefined;
    });
    const r = render(() => <AgentsSection />);
    await waitFor(() => expect(r.container.textContent).toContain("Claude"));
    expect(r.queryByText("Check again")).toBeNull();

    await openCard(r);
    expect(r.getByText("Check again")).toBeTruthy();
  });
});
