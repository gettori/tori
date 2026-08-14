import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
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
