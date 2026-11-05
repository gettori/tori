import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import AgentDetail from "./AgentDetail";
import { reloadAdapters } from "../../../../utils/agents";
import type { AgentHealth } from "../../../../utils/agentHealth";
import { DEFAULT_SETTINGS, loadSettings } from "../../settingsStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/home/me" }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
const invoked = vi.mocked(invoke);

const health = {
  id: "pi",
  label: "Pi",
  program: "pi",
  status: "versionMatch",
  signIn: "signedIn",
  account: null,
  apiKeySource: null,
  path: "/usr/bin/pi",
  version: "1.0.0",
  verifiedAgainst: "pi 1.0.0",
  sessionsDir: null,
  sessionsDirExists: false,
  hooks: false,
  needsYou: false,
  overridePath: null,
} as unknown as AgentHealth;

const adapter = {
  id: "pi",
  label: "Pi",
  icon: "pi",
  program: "pi",
  base_args: [],
  yolo_args: [],
  resume_args: [],
  parser_kind: null,
  running_pattern: null,
  pty_quiet_ms: 2000,
  chat: null,
  accounts: null,
  provenance: { source: "catalog", updateAvailable: true, catalogConflict: false },
};

beforeEach(async () => {
  invoked.mockReset();
  invoked.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "list_agents") return [adapter];
    if (cmd === "get_settings") return { ...DEFAULT_SETTINGS, agent: { enabled: { pi: true } } };
    if (cmd === "set_settings") return (args as { settings: unknown }).settings;
    if (cmd === "agent_accounts")
      return { adapterId: "pi", declared: false, canAdd: false, canSignOut: false, profiles: [] };
    return null;
  });
  await loadSettings();
  await reloadAdapters();
});

describe("a catalog agent's page", () => {
  it("offers Update pack and Remove pack", async () => {
    render(() => (
      <AgentDetail agent={health} projectRoot={null} onBack={() => {}} onRecheck={async () => {}} rechecking={false} />
    ));

    fireEvent.click(await waitFor(() => screen.getByLabelText("Update the Pi pack")));
    await waitFor(() => expect(invoked).toHaveBeenCalledWith("packs_update", { kind: "agents", id: "pi" }));
    const remove = () => screen.getByLabelText("Remove the Pi pack") as HTMLButtonElement;
    await waitFor(() => expect(remove().disabled).toBe(false));
    fireEvent.click(remove());
    await waitFor(() => expect(invoked).toHaveBeenCalledWith("packs_remove", { kind: "agents", id: "pi" }));
  });
});
