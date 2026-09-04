import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import SessionInfo from "./SessionInfo";
import type { McpServer } from "../../utils/chatTypes";
import type { PublishedCapability } from "../../utils/chatCapabilities";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
const invoked = vi.mocked(invoke);

const server = (over: Partial<McpServer> = {}): McpServer => ({
  name: "ctx",
  status: "connected",
  toolCount: 11,
  error: null,
  ...over,
});

const props = (over: Partial<Parameters<typeof SessionInfo>[0]> = {}) => ({
  mcpServers: [] as McpServer[],
  skills: [] as string[],
  agents: [] as string[],
  plugins: [] as { name: string; version: string | null; source: string | null; path: string | null }[],
  account: null,
  capabilities: [] as PublishedCapability[],
  ...over,
});

const open = (container: HTMLElement) => {
  const toggle = container.querySelector("button");
  if (!toggle) throw new Error("no disclosure toggle rendered");
  fireEvent.click(toggle);
};

describe("SessionInfo", () => {
  beforeEach(() => {
    invoked.mockReset();
    invoked.mockResolvedValue([]);
  });

  it("names the plan and the organization the handshake reported", () => {
    const { container } = render(() => (
      <SessionInfo
        {...props({ account: { subscriptionType: "Claude Pro", organization: "Acme", apiProvider: "firstParty" } })}
      />
    ));
    open(container);
    expect(container.textContent).toContain("Claude Pro");
    expect(container.textContent).toContain("Acme");
  });

  // Which account this session is on, which the caller has already decided is
  // worth naming. It shows before the handshake has said anything, because it
  // is the one fact about the account that is known at spawn.
  it("names the account the session runs as, when there is more than one", () => {
    const { container } = render(() => <SessionInfo {...props({ profileLabel: "Fonn" })} />);
    open(container);
    expect(container.textContent).toContain("Account");
    expect(container.textContent).toContain("Fonn");
  });

  // A single-account install has nothing to tell apart, so `profileLabel` comes
  // back null and this section is the handshake's alone. "Default" on every
  // chat would be a label nobody can act on.
  it("says nothing about the account on a single-account install", () => {
    const { container } = render(() => (
      <SessionInfo
        {...props({
          profileLabel: null,
          account: { subscriptionType: "Claude Max", organization: "", apiProvider: "" },
        })}
      />
    ));
    open(container);
    expect(container.textContent).toContain("Claude Max");
    expect(container.textContent).not.toContain("Default");
  });

  it("reads the user-scope config from the session's own account", async () => {
    const { container } = render(() => (
      <SessionInfo {...props({ cwd: "/repo", agentId: "claude", profile: "fonn" })} />
    ));
    open(container);
    // The profile id, not a resolved home: `.claude.json` lives inside an
    // isolated home rather than beside it, and only the backend knows where.
    await waitFor(() =>
      expect(invoked).toHaveBeenCalledWith("chat_mcp_list", {
        cwd: "/repo",
        agentId: "claude",
        profile: "fonn",
      }),
    );
  });

  // The account has one source, the `initialize` handshake, so a session that
  // skipped it knows nothing rather than knowing a free tier. Rendering a
  // guessed or blank plan would be a claim about the user's billing.
  it("shows no account section at all when the handshake did not happen", () => {
    const { container } = render(() => <SessionInfo {...props({ mcpServers: [server()], account: null })} />);
    open(container);
    expect(container.textContent).not.toContain("Account");
  });

  // The agent can name an account without naming an organization, and an
  // empty string next to a separator reads as a rendering bug.
  it("omits the organization line when the account carries none", () => {
    const { container } = render(() => (
      <SessionInfo {...props({ account: { subscriptionType: "Claude Max", organization: "", apiProvider: "" } })} />
    ));
    open(container);
    expect(container.textContent).toContain("Claude Max");
    expect(container.textContent).not.toContain("·");
  });

  it("does not open with a separator when only an organization is named", () => {
    const { container } = render(() => (
      <SessionInfo {...props({ account: { subscriptionType: "", organization: "Acme", apiProvider: "" } })} />
    ));
    open(container);
    expect(container.textContent).toContain("Acme");
    expect(container.textContent).not.toContain("·");
  });

  it("renders nothing for a session that loaded none of it", () => {
    const { container } = render(() => <SessionInfo {...props()} />);
    expect(container.textContent).toBe("");
  });

  it("shows a connected server with its tool count", () => {
    const { container } = render(() => <SessionInfo {...props({ mcpServers: [server()] })} />);
    open(container);
    expect(container.textContent).toContain("ctx");
    expect(container.textContent).toContain("connected");
    expect(container.textContent).toContain("11 tools");
  });

  it("shows a failed server with its error, and says so before being opened", () => {
    // The whole reason someone opens this panel, so the count is in the summary.
    const { container } = render(() => (
      <SessionInfo
        {...props({ mcpServers: [server({ name: "broken", status: "failed", toolCount: null, error: "ENOENT" })] })}
      />
    ));
    expect(container.textContent).toContain("1 not connected");
    open(container);
    expect(container.textContent).toContain("broken");
    expect(container.textContent).toContain("failed");
    expect(container.textContent).toContain("ENOENT");
  });

  it("says zero tools rather than hiding the count", () => {
    // A connected server exposing nothing is a real and confusing state; it
    // must be distinguishable from one that reported no count at all.
    const { container } = render(() => <SessionInfo {...props({ mcpServers: [server({ toolCount: 0 })] })} />);
    open(container);
    expect(container.textContent).toContain("0 tools");
  });

  it("omits the tool count when the agent reported none", () => {
    // A server declaring no count must not read as having zero tools.
    const { container } = render(() => <SessionInfo {...props({ mcpServers: [server({ toolCount: null })] })} />);
    open(container);
    expect(container.textContent).not.toContain("tools");
  });

  it("lists skills, agents and plugins", () => {
    const { container } = render(() => (
      <SessionInfo
        {...props({
          skills: ["adversary", "grill-plan"],
          agents: ["Explore"],
          plugins: [{ name: "context-mode", version: "1.0.162", source: null, path: null }],
        })}
      />
    ));
    expect(container.textContent).toContain("2 skills");
    open(container);
    expect(container.textContent).toContain("adversary");
    expect(container.textContent).toContain("Explore");
    expect(container.textContent).toContain("context-mode");
    expect(container.textContent).toContain("1.0.162");
  });

  it("writes a new server to the project config through Claude's own shape", async () => {
    // The command/args split is what `claude mcp add <name> -- <cmd> <args>`
    // produces, so the file Sway writes is one Claude already understands.
    invoked.mockResolvedValue([]);
    const { container, getByPlaceholderText, getByText } = render(() => (
      <SessionInfo {...props({ cwd: "/repo" })} />
    ));
    open(container);
    await waitFor(() =>
      expect(invoked).toHaveBeenCalledWith("chat_mcp_list", {
        cwd: "/repo",
        agentId: "claude",
        profile: null,
      }),
    );

    fireEvent.click(getByText("Add server"));
    fireEvent.input(getByPlaceholderText("name"), { target: { value: "everything" } });
    fireEvent.input(getByPlaceholderText("npx -y @scope/server"), {
      target: { value: "npx -y @modelcontextprotocol/server-everything" },
    });
    fireEvent.click(getByText("Save"));

    await waitFor(() =>
      expect(invoked).toHaveBeenCalledWith("chat_mcp_add", {
        cwd: "/repo",
        name: "everything",
        config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
        agentId: "claude",
        profile: null,
      }),
    );
  });

  it("says a project server is pending approval rather than pretending it is live", async () => {
    // Measured against claude 2.1.220: a freshly written .mcp.json server is
    // loaded as pending and not connected to. Sway reports that instead of
    // force-enabling it, because the approval lives in Claude's own state file.
    invoked.mockResolvedValue([
      { name: "everything", scope: "project", approval: "pending", config: {} },
    ]);
    const { container } = render(() => <SessionInfo {...props({ cwd: "/repo" })} />);
    open(container);
    await waitFor(() => expect(container.textContent).toContain("pending approval"));
  });

  it("offers Remove only for the project scope Sway actually writes", async () => {
    invoked.mockResolvedValue([
      { name: "mine", scope: "project", approval: "approved", config: {} },
      { name: "theirs", scope: "user", approval: "notApplicable", config: {} },
    ]);
    const { container, getAllByText } = render(() => <SessionInfo {...props({ cwd: "/repo" })} />);
    open(container);
    await waitFor(() => expect(container.textContent).toContain("theirs"));
    // One button, for the project-scoped server only: a user-scoped server
    // lives in a file Sway deliberately never writes.
    expect(getAllByText("Remove")).toHaveLength(1);
  });

  it("surfaces a failed write instead of silently doing nothing", async () => {
    invoked.mockResolvedValueOnce([]);
    const { container, getByText, getByPlaceholderText } = render(() => (
      <SessionInfo {...props({ cwd: "/repo" })} />
    ));
    open(container);
    await waitFor(() => expect(invoked).toHaveBeenCalled());
    invoked.mockRejectedValueOnce("permission denied");
    fireEvent.click(getByText("Add server"));
    fireEvent.input(getByPlaceholderText("name"), { target: { value: "x" } });
    fireEvent.input(getByPlaceholderText("npx -y @scope/server"), { target: { value: "cmd" } });
    fireEvent.click(getByText("Save"));
    await waitFor(() => expect(container.textContent).toContain("permission denied"));
  });

  it("starts collapsed so it costs no space above the transcript", () => {
    const { container } = render(() => <SessionInfo {...props({ mcpServers: [server()] })} />);
    expect(container.textContent).not.toContain("11 tools");
    expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  });

  // The tier is a per-session fact for a generic transport: two ACP agents
  // behind one transport publish different lists, so the list belongs beside
  // what the session loaded rather than only on the Agents cards in Settings.
  it("publishes this chat's capabilities with their qualified values", () => {
    const { container } = render(() => (
      <SessionInfo
        {...props({
          capabilities: [
            { key: "approvals", value: "in-protocol", label: "approvals: in-protocol" },
            { key: "history", value: "session/load", label: "history: session/load" },
          ],
        })}
      />
    ));
    open(container);
    expect(container.textContent).toContain("approvals: in-protocol");
    expect(container.textContent).toContain("history: session/load");
    // The bare feature name would promise the unqualified capability.
    expect(container.textContent).not.toContain("approvals,");
  });

  it("renders no capability section for a agent that publishes none", () => {
    const { container } = render(() => <SessionInfo {...props({ mcpServers: [server()] })} />);
    open(container);
    expect(container.textContent).not.toContain("Chat capabilities");
  });
});
