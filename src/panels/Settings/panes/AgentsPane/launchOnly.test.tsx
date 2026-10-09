// A launch-only adapter (schema v6, `capabilities.sessions = false`): Tori
// starts it in a terminal tab and has no session list or chat pane to offer.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, waitFor, fireEvent } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import AgentsSection from "./AgentsSection";
import styles from "../../Settings.module.css";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/home/me" }));
const invoked = vi.mocked(invoke);

const health = {
  id: "acme",
  label: "Acme",
  program: "acme",
  status: "versionUnknown",
  signIn: "unknown",
  account: null,
  apiKeySource: null,
  path: "/usr/local/bin/acme",
  version: null,
  verifiedAgainst: null,
  sessionsDir: null,
  sessionsDirExists: false,
  hooks: false,
  needsYou: false,
  overridePath: null,
};

const acme = {
  id: "acme",
  label: "Acme",
  icon: null,
  program: "acme",
  base_args: [],
  yolo_args: [],
  resume_args: [],
  parser_kind: null,
  running_pattern: null,
  pty_quiet_ms: 2000,
  sessions: false,
  chat: null,
  accounts: null,
};

function mount() {
  invoked.mockReset();
  invoked.mockImplementation(async (cmd: string) => {
    if (cmd === "agent_health" || cmd === "refresh_agent_health") return [health];
    if (cmd === "list_agents") return [acme];
    if (cmd === "agent_install_route") return { type: "undeclared" };
    if (cmd === "agent_update_route") return { type: "undeclared" };
    if (cmd === "agent_uninstall_route") return { type: "undeclared" };
    if (cmd === "agent_accounts")
      return { adapterId: "acme", declared: false, canAdd: false, canSignOut: false, profiles: [] };
    return [];
  });
  return render(() => <AgentsSection />);
}

describe("a launch-only agent", () => {
  beforeEach(() => invoked.mockReset());

  it("notes the terminal as how Tori drives it", async () => {
    const { container } = mount();
    await waitFor(() =>
      expect(container.querySelector(`[data-agent="acme"] .${styles.agentNote}`)?.textContent).toBe("Terminal"),
    );
  });

  it("says it runs in a terminal tab and lists no sessions", async () => {
    const r = mount();
    fireEvent.click(await r.findByRole("button", { name: /Acme/ }));
    await waitFor(() => expect(r.container.textContent).toContain("Runs in a terminal tab, no chat pane."));
    expect(r.container.textContent).not.toContain("Tori has no chat transport");
    const groups = [...r.container.querySelectorAll(`.${styles.groupTitle}`)].map((g) => g.textContent);
    expect(groups).not.toContain("Sessions");
  });
});
