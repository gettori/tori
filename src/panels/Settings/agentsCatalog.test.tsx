import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import AgentsSection from "./AgentsSection";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invoked = vi.mocked(invoke);

const row = (over: Record<string, unknown> = {}) => ({
  id: "cursor",
  label: "Cursor",
  description: "Cursor's coding agent",
  registryVersion: "2026.08.11",
  website: "https://cursor.com/docs/cli/acp",
  command: "cursor-agent acp",
  needs: "on-path",
  coveredBy: null,
  ...over,
});

const health = (over: Record<string, unknown> = {}) => ({
  id: "claude",
  label: "Claude",
  program: "claude",
  status: "versionMatch",
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
      if (cmd === "acp_catalog_source") {
        return {
          source: "https://github.com/agentclientprotocol/registry",
          registryCommit: "2dd65dacffffffffffffffffffffffffffffffff",
          generatedOn: "2026-08-14",
        };
      }
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
      if (cmd === "acp_catalog_source") {
        return { source: "s", registryCommit: "abcdef1234", generatedOn: "2026-08-14" };
      }
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
    const titles = [...container.querySelectorAll("[class*='cardTitle']")].map((n) => n.textContent);
    expect(titles).toEqual(["Claude"]);
    expect(cards.length).toBeGreaterThan(0);

    // And the registry's own pinned version is not presented as a version Sway
    // checked: the row says untested, and nothing on it reads as a match.
    expect(container.textContent).not.toContain("Installed, version 2026.08.11");
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

  it("offers a re-probe on a missing binary, and stops telling the user to restart", async () => {
    const { container, getByText } = render(() => <AgentsSection />);
    await waitFor(() => expect(container.textContent).toContain("Not installed"));

    // The old copy said "reopen Sway to pick it up", which stopped being true
    // when the health sweep became invalidatable.
    expect(container.textContent).not.toContain("reopen Sway");
    getByText("Check again");
  });

  it("re-probes through the refresh command rather than re-reading the cache", async () => {
    const { container, getByText } = render(() => <AgentsSection />);
    await waitFor(() => expect(container.textContent).toContain("Not installed"));

    invoked.mockClear();
    fireEvent.click(getByText("Check again"));

    await waitFor(() =>
      expect(invoked.mock.calls.some(([cmd]) => cmd === "refresh_agent_health")).toBe(true),
    );
  });

  it("leaves a healthy agent without an action, so the button means something", async () => {
    invoked.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_health") return [health()];
      if (cmd === "acp_catalog") return [];
      if (cmd === "acp_catalog_source") return null;
      return undefined;
    });
    const { container, queryByText } = render(() => <AgentsSection />);
    await waitFor(() => expect(container.textContent).toContain("Installed, version"));
    expect(queryByText("Check again")).toBeNull();
  });
});
