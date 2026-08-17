// The agents list as a table: one row per agent, a verdict per row, and the
// section's own chrome (re-check, filter) in the title row.
//
// What these tests protect is the reading, not the pixels: every row carries
// the same answers in the same order, the verdict column is always filled (an
// empty cell in a filled column reads as a bug, not as calm), and the filter
// narrows what is on screen without ever changing what a row says.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import AgentsSection from "./AgentsSection";
import styles from "../../Settings.module.css";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/home/me" }));
const invoked = vi.mocked(invoke);

const row = (over: Record<string, unknown> = {}) => ({
  id: "claude",
  label: "Claude",
  program: "claude",
  status: "versionMatch",
  signIn: "signedIn",
  account: "a@b.c",
  apiKeySource: null,
  path: "/usr/bin/claude",
  version: "2.1.231",
  verifiedAgainst: "claude 2.1.231",
  sessionsDir: null,
  sessionsDirExists: false,
  hooks: false,
  needsYou: false,
  overridePath: null,
  ...over,
});

const notInstalled = (id: string, label: string) =>
  row({
    id,
    label,
    program: id,
    status: "notFound",
    signIn: "unknown",
    account: null,
    path: null,
    version: null,
    verifiedAgainst: null,
  });

/** Only what the section reads off an adapter: naming facts and the chat
 *  transport the row's note names. */
const adapter = (id: string, label: string, transport: string | null) => ({
  id,
  label,
  icon: id,
  program: id,
  base_args: [],
  yolo_args: [],
  resume_args: [],
  parser_kind: null,
  running_pattern: null,
  pty_quiet_ms: 2000,
  chat: transport ? { transport } : null,
  accounts: null,
});

function mount(
  rows = [row(), notInstalled("copilot", "Copilot")],
  counts: Record<string, number> = { claude: 2 },
) {
  invoked.mockReset();
  invoked.mockImplementation(async (cmd: string) => {
    if (cmd === "agent_health" || cmd === "refresh_agent_health") return rows;
    // The resolved adapters, because the row's note reads the chat transport
    // and the fallback list deliberately carries none.
    if (cmd === "list_agents")
      return [adapter("claude", "Claude", "claude_stream_json"), adapter("copilot", "Copilot", "acp")];
    if (cmd === "agent_account_counts") return counts;
    if (cmd === "agent_accounts")
      return { adapterId: "claude", declared: false, canAdd: false, canSignOut: false, profiles: [] };
    return [];
  });
  return render(() => <AgentsSection />);
}

const cell = (container: HTMLElement, id: string, cls: string) =>
  container.querySelector(`[data-agent="${id}"] .${cls}`)?.textContent?.trim() ?? "";

describe("the agents table", () => {
  beforeEach(() => invoked.mockReset());

  it("gives every row a verdict, including the calm one", async () => {
    const { container, findByText } = mount();
    await findByText("Ready");
    // "Ready" is painted here where the old cards suppressed it: a table
    // column that is only sometimes filled reads as broken rows.
    expect(container.textContent).toContain("Not installed");
  });

  // The note carries standing facts (who ships it, how Sway drives it), not
  // status: sign-in, billing and install hints live on the agent's page, and
  // the state cell already carries the verdict.
  it("notes the provider and the transport, not the account", async () => {
    const { container, findByText } = mount();
    await findByText("Ready");
    expect(container.textContent).toContain("Anthropic · Native");
    expect(container.textContent).toContain("GitHub · ACP");
    expect(container.textContent).not.toContain("a@b.c");
  });

  // Stored profiles from the accounts file, no probe behind them. "-" for an
  // adapter with no [accounts] table, because a default "1" would claim an
  // account Sway has nothing true to say about.
  it("counts stored accounts, and claims none for an undeclared adapter", async () => {
    const { container, findByText } = mount();
    await findByText("Ready");
    await waitFor(() => expect(cell(container, "claude", styles.agentCount)).toBe("2"));
    expect(cell(container, "copilot", styles.agentCount)).toBe("-");
  });

  // The verdict is the most actionable fact, not the most severe: a signed-out
  // agent says what to do next, and the drift detail waits on its page.
  it("turns a signed-out agent's verdict into the action", async () => {
    const { findByText } = mount([row({ signIn: "signedOut", account: null })]);
    await findByText("Sign in");
  });

  it("narrows to matching rows and says when nothing matches", async () => {
    const r = mount();
    const box = await r.findByLabelText("Search agents");
    await r.findByText("Ready");

    fireEvent.input(box, { target: { value: "cla" } });
    expect(r.container.querySelector('[data-agent="claude"]')).not.toBeNull();
    expect(r.container.querySelector('[data-agent="copilot"]')).toBeNull();

    fireEvent.input(box, { target: { value: "nope" } });
    expect(r.container.textContent).toContain('No agent matches "nope"');

    // Clearing restores the full list rather than remembering the filter.
    fireEvent.input(box, { target: { value: "" } });
    expect(r.container.querySelector('[data-agent="copilot"]')).not.toBeNull();
  });

  // The note is on the row, so it is searchable text: "github" finding
  // Copilot is the provider column earning its keep.
  it("matches on the provider too", async () => {
    const r = mount();
    await r.findByText("Ready");
    fireEvent.input(await r.findByLabelText("Search agents"), { target: { value: "github" } });
    expect(r.container.querySelector('[data-agent="copilot"]')).not.toBeNull();
    expect(r.container.querySelector('[data-agent="claude"]')).toBeNull();
  });

  it("re-runs the sweep from the title row's reload button", async () => {
    const r = mount();
    fireEvent.click(await r.findByLabelText("Check again"));
    await waitFor(() =>
      expect(invoked.mock.calls.some((c) => c[0] === "refresh_agent_health")).toBe(true),
    );
  });
});
