// What a harness offers to pick from, on the card as a count and on its own
// page as a list.
//
// The count is a claim, so it comes from the resolved adapter and nowhere else.
// `findAgent` answers with the first bundled adapter for an id it cannot
// resolve, which would put Claude's models under somebody else's name; these
// tests pin that it does not happen, and that a harness declaring none says why
// rather than showing a zero.
//
// One adapter list for the whole file, varied by which harness the health sweep
// reports: `ensureAgentsLoaded` fetches once per module and caches, so a
// per-test `list_agents` would answer only the first test and silently reuse it
// for the rest.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import AgentsSection from "./AgentsSection";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/home/me" }));
const invoked = vi.mocked(invoke);

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
  sessionsDir: "/home/me/.claude/projects",
  sessionsDirExists: true,
  hooks: false,
  needsYou: false,
  overridePath: null,
  ...over,
});

const model = (over: Record<string, unknown> = {}) => ({
  id: "claude-opus-5",
  label: "Opus 5",
  context_window: 1_000_000,
  effort_levels: ["low", "high"],
  supports_thinking: true,
  supports_images: true,
  ...over,
});

const adapter = (id: string, models: unknown[]) => ({
  id,
  label: id,
  program: id,
  base_args: [],
  yolo_args: [],
  resume_args: [],
  parser_kind: null,
  running_pattern: "",
  pty_quiet_ms: 0,
  chat: {
    program: id,
    transport: "claude_stream_json",
    base_args: [],
    session_id_args: [],
    resume_args: [],
    model_args: [],
    effort_args: [],
    mode_args: [],
    add_dir_args: [],
    models,
    modes: [],
    effort: [],
    acp: { serve_client_fs: false },
  },
  accounts: null,
});

const ADAPTERS = [
  adapter("claude", [model(), model({ id: "claude-haiku-4-5", label: "Haiku 4.5" })]),
  adapter("solo", [model()]),
  adapter("overprotocol", []),
];

function mount(over: Record<string, unknown> = {}) {
  invoked.mockReset();
  invoked.mockImplementation(async (cmd: string) => {
    if (cmd === "agent_health") return [health(over)];
    if (cmd === "list_agents") return ADAPTERS;
    if (cmd === "agent_accounts") return { adapterId: "claude", declared: false, profiles: [] };
    return [];
  });
  return render(() => <AgentsSection />);
}

const open = async (r: ReturnType<typeof render>, name: RegExp) => {
  fireEvent.click(await r.findByRole("button", { name }));
  await waitFor(() => expect(r.container.textContent).toContain("Chat capabilities"));
  return r;
};

describe("how many models a harness offers", () => {
  beforeEach(() => invoked.mockReset());

  it("counts them on the card", async () => {
    const { container } = mount();
    await waitFor(() => expect(container.textContent).toContain("2 models"));
  });

  it("says model, not models, when there is one", async () => {
    const { container } = mount({ id: "solo", label: "Solo", program: "solo" });
    await waitFor(() => expect(container.textContent).toContain("1 model"));
    expect(container.textContent).not.toContain("1 models");
  });

  // An ACP harness names its models on the session handshake, so the adapter
  // declares none. "0 models" would read as a broken install.
  it("shows no count at all for a harness that declares none", async () => {
    const { container } = mount({ id: "overprotocol", label: "Over Protocol", program: "op" });
    await waitFor(() => expect(container.textContent).toContain("Over Protocol"));
    expect(container.textContent).not.toContain("0 models");
    expect(container.textContent).not.toContain("model");
  });

  // The failure this guards: `findAgent` answers with the first bundled adapter
  // for an id it does not know, which would put two models on a harness that
  // has never declared one.
  it("never inherits another adapter's models", async () => {
    const { container } = mount({ id: "mystery", label: "Mystery", program: "mystery" });
    await waitFor(() => expect(container.textContent).toContain("Mystery"));
    expect(container.textContent).not.toContain("2 models");
  });
});

describe("the model list on a harness page", () => {
  beforeEach(() => invoked.mockReset());

  it("names each model, its id and what it can do", async () => {
    const { container } = await open(mount(), /Claude/);
    expect(container.textContent).toContain("Opus 5");
    expect(container.textContent).toContain("claude-opus-5");
    expect(container.textContent).toContain("1M context");
    expect(container.textContent).toContain("low, high");
    expect(container.textContent).toContain("thinking");
  });

  it("explains the absence rather than showing an empty list", async () => {
    const { container } = await open(
      mount({ id: "overprotocol", label: "Over Protocol", program: "op" }),
      /Over Protocol/,
    );
    expect(container.textContent).toContain("names its own models when a session starts");
  });
});
