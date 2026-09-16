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
import switchStyles from "../../../../components/Switch/Switch.module.css";
import { askForAgentCard, wantedAgentCard } from "../../../../utils/agentCard";
import { DEFAULT_SETTINGS, loadSettings } from "../../settingsStore";

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

/** Mount with both agents already turned on, since the verdicts these tests
 *  read are health's and "Off" would mask them. The one test that cares about
 *  the switch passes its own set. */
async function mount(
  rows = [row(), notInstalled("copilot", "Copilot")],
  counts: Record<string, number> = { claude: 2 },
  enabled: Record<string, boolean> = { claude: true, copilot: true },
) {
  invoked.mockReset();
  invoked.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "agent_health" || cmd === "refresh_agent_health") return rows;
    // The resolved adapters, because the row's note reads the chat transport
    // and the fallback list deliberately carries none.
    if (cmd === "list_agents")
      return [adapter("claude", "Claude", "claude_stream_json"), adapter("copilot", "Copilot", "acp")];
    if (cmd === "agent_account_counts") return counts;
    if (cmd === "agent_accounts")
      return { adapterId: "claude", declared: false, canAdd: false, canSignOut: false, profiles: [] };
    if (cmd === "get_settings") return { ...DEFAULT_SETTINGS, agent: { enabled } };
    if (cmd === "set_settings") return (args as { settings: unknown }).settings;
    return [];
  });
  await loadSettings();
  return render(() => <AgentsSection />);
}

const cell = (container: HTMLElement, id: string, cls: string) =>
  container.querySelector(`[data-agent="${id}"] .${cls}`)?.textContent?.trim() ?? "";

describe("the agents table", () => {
  beforeEach(() => invoked.mockReset());

  it("gives every row a verdict, including the calm one", async () => {
    const { container, findByText } = await mount();
    await findByText("Ready");
    // "Ready" is painted here where the old cards suppressed it: a table
    // column that is only sometimes filled reads as broken rows.
    expect(container.textContent).toContain("Not installed");
  });

  // The note carries standing facts (who ships it, how Tori drives it), not
  // status: sign-in, billing and install hints live on the agent's page, and
  // the state cell already carries the verdict.
  it("notes the provider and the transport, not the account", async () => {
    const { container, findByText } = await mount();
    await findByText("Ready");
    expect(container.textContent).toContain("Anthropic · Native");
    expect(container.textContent).toContain("GitHub · ACP");
    expect(container.textContent).not.toContain("a@b.c");
  });

  // Stored profiles from the accounts file, no probe behind them. "-" for an
  // adapter with no [accounts] table, because a default "1" would claim an
  // account Tori has nothing true to say about.
  it("counts stored accounts, and claims none for an undeclared adapter", async () => {
    const { container, findByText } = await mount();
    await findByText("Ready");
    await waitFor(() => expect(cell(container, "claude", styles.agentCount)).toBe("2"));
    expect(cell(container, "copilot", styles.agentCount)).toBe("-");
  });

  // The verdict is the most actionable fact, not the most severe: a signed-out
  // agent says what to do next, and the drift detail waits on its page.
  // Drift has a direction. Behind the measured version, a newer release
  // provably exists and the verdict says so; ahead of it is the steady state
  // of a fast-shipping vendor and reads as plain Ready.
  it("calls a binary behind the measurement Outdated, and one ahead Ready", async () => {
    const { findByText, container } = await mount([
      row({ status: "versionDrift", version: "2.1.100", verifiedAgainst: "claude 2.1.231" }),
      row({
        id: "copilot",
        label: "Copilot",
        program: "copilot",
        status: "versionDrift",
        version: "1.2.0",
        verifiedAgainst: "copilot 1.0.80",
      }),
    ]);
    await findByText("Outdated");
    const pill = (id: string) =>
      container.querySelector(`[data-agent="${id}"] .${styles.statePill}`)?.textContent;
    expect(pill("claude")).toBe("Outdated");
    expect(pill("copilot")).toBe("Ready");
  });

  it("turns a signed-out agent's verdict into the action", async () => {
    const { findByText } = await mount([row({ signIn: "signedOut", account: null })]);
    await findByText("Sign in");
  });

  it("narrows to matching rows and says when nothing matches", async () => {
    const r = await mount();
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
    const r = await mount();
    await r.findByText("Ready");
    fireEvent.input(await r.findByLabelText("Search agents"), { target: { value: "github" } });
    expect(r.container.querySelector('[data-agent="copilot"]')).not.toBeNull();
    expect(r.container.querySelector('[data-agent="claude"]')).toBeNull();
  });

  it("re-runs the sweep from the title row's reload button", async () => {
    const r = await mount();
    fireEvent.click(await r.findByLabelText("Check again"));
    await waitFor(() =>
      expect(invoked.mock.calls.some((c) => c[0] === "refresh_agent_health")).toBe(true),
    );
  });

  // The chat palette's "Fix" row sends the reader here. The ask survives the
  // gap between the click and this pane existing, which is why it is a value
  // rather than an event: nothing is listening at the moment of the click.
  it("opens the card somebody asked for, and consumes the ask", async () => {
    askForAgentCard("copilot");
    const r = await mount();
    // The detail page in place of the list: its own back control is what says
    // the reader is on a card rather than looking at rows.
    await waitFor(() => expect(r.container.querySelector(`.${styles.detailBack}`)).not.toBeNull());
    expect(r.container.querySelector('[data-agent="copilot"]')).toBeNull();
    expect(wantedAgentCard()).toBeNull();
  });

  // The dependency runs one way. STATE is health's answer and says nothing
  // about the switch, so a usable agent nobody has turned on still reads Ready.
  it("keeps the state column health-only, whichever way the switch is set", async () => {
    const off = await mount(undefined, undefined, {});
    expect(
      (await off.findByText("Ready")).textContent,
    ).toBe("Ready");
    off.unmount();
    const on = await mount();
    expect((await on.findByText("Ready")).textContent).toBe("Ready");
  });

  // Refused rather than hidden: the STATE cell beside it already says what to
  // fix, and a switch that vanished would leave the reader guessing.
  it("refuses the switch for an agent whose state is not Ready", async () => {
    const r = await mount(undefined, undefined, { claude: true });
    const claude = (await r.findByLabelText("Offer Claude in Tori")) as HTMLInputElement;
    const copilot = (await r.findByLabelText("Offer Copilot in Tori")) as HTMLInputElement;
    expect(claude.disabled).toBe(false);
    expect(copilot.disabled).toBe(true);
  });

  // Outdated is a notice, never a gate: the binary is older than the one Tori
  // measured against and still runs, so refusing it would lock a working
  // install out of the app over Tori's own bookkeeping.
  it("lets an Outdated agent be turned on", async () => {
    const r = await mount(
      [row({ status: "versionDrift", version: "2.1.100", verifiedAgainst: "claude 2.1.231" })],
      undefined,
      {},
    );
    await r.findByText("Outdated");
    expect((r.getByLabelText("Offer Claude in Tori") as HTMLInputElement).disabled).toBe(false);
  });

  // Off is always reachable. An agent turned on and then uninstalled would
  // otherwise be something the reader can see, cannot use, and cannot undo.
  it("still lets an agent that broke be turned off", async () => {
    const r = await mount([notInstalled("claude", "Claude")], undefined, { claude: true });
    await r.findByText("Not installed");
    const box = r.getByLabelText("Offer Claude in Tori") as HTMLInputElement;
    expect(box.disabled).toBe(false);
    expect(box.checked).toBe(true);
  });

  // The switch carries no words of its own, so a hover description is where it
  // says what it does. `data-closed` is Kobalte's mark on a tooltip trigger,
  // which is what says the machinery landed on the visible track.
  it("describes the switch on hover", async () => {
    const r = await mount(undefined, undefined, { claude: true });
    const track = r.container.querySelector(
      `[data-agent="claude"] ~ .${switchStyles.root} .${switchStyles.control}`,
    );
    expect(track?.hasAttribute("data-closed")).toBe(true);
  });

  it("writes the flip through set_settings, keyed by adapter id", async () => {
    const r = await mount(undefined, undefined, {});
    fireEvent.click(await r.findByLabelText("Offer Claude in Tori"));
    await waitFor(() => {
      const call = invoked.mock.calls.find((c) => c[0] === "set_settings");
      expect((call?.[1] as { settings: { agent: { enabled: Record<string, boolean> } } })?.settings.agent.enabled)
        .toEqual({ claude: true });
    });
  });

  it("opens no card when nobody asked", async () => {
    const r = await mount();
    await r.findByText("Ready");
    expect(r.container.querySelector('[data-agent="copilot"]')).not.toBeNull();
  });
});
