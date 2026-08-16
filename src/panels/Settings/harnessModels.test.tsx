// What a harness offers to pick from, on the card as a count and on its own
// page as a list.
//
// **The adapter is no longer an answer to either.** These tests used to assert
// counts and rows read out of `[[chat.models]]`; that table is gone, because a
// count is a claim about what the installed binary can run and a TOML cannot
// make it. Every harness now reads the same way until the probe cache is wired
// in, which is also exactly how a never-probed harness has to read afterwards.
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

const adapter = (id: string) => ({
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
    annotations: [],
    modes: [],
    effort: [],
    acp: { serve_client_fs: false },
  },
  accounts: null,
});

const ADAPTERS = [adapter("claude"), adapter("solo"), adapter("overprotocol")];

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

// **No count comes from an adapter any more.** These used to assert "2 models"
// for Claude, read straight out of `[[chat.models]]`. A count is a claim about
// what the installed binary can run, and a TOML cannot make it: the table said
// four models regardless of the CLI on the machine, and its windows said 200k
// for models the harness reports 1M for.
//
// Nothing renders here until the probe cache is wired in (Phase 4), and a
// never-probed harness must render exactly this way once it is: no count, rather
// than a zero that reads as a broken install.
describe("how many models a harness offers", () => {
  beforeEach(() => invoked.mockReset());

  it("claims no count for a harness nothing has asked", async () => {
    const { container } = mount();
    await waitFor(() => expect(container.textContent).toContain("Claude"));
    expect(container.textContent).not.toContain("model");
  });

  it("says the same for every harness, whatever its adapter used to declare", async () => {
    for (const over of [
      { id: "solo", label: "Solo", program: "solo" },
      { id: "overprotocol", label: "Over Protocol", program: "op" },
      { id: "mystery", label: "Mystery", program: "mystery" },
    ]) {
      const { container, unmount } = mount(over);
      await waitFor(() => expect(container.textContent).toContain(over.label));
      expect(container.textContent).not.toContain("model");
      unmount();
    }
  });
});

describe("the model list on a harness page", () => {
  beforeEach(() => invoked.mockReset());

  // Claude declared four models and the page listed them with windows and
  // effort levels. It reads like every other harness now, because it is in the
  // same position as every other harness: nothing has asked it yet.
  it("shows no list, for the harness that used to have one", async () => {
    const { container } = await open(mount(), /Claude/);
    expect(container.textContent).toContain("names its own models when a session starts");
    expect(container.textContent).not.toContain("Opus 5");
    expect(container.textContent).not.toContain("1M context");
  });

  it("explains the absence rather than showing an empty list", async () => {
    const { container } = await open(
      mount({ id: "overprotocol", label: "Over Protocol", program: "op" }),
      /Over Protocol/,
    );
    expect(container.textContent).toContain("names its own models when a session starts");
  });
});

// A catalogue probe spawns the harness's binary. `model_catalogs` reads the
// cache and is free; the two `refresh_*` commands are not, and nothing a user
// merely *looks at* may call them. The split exists so a read cannot become a
// probe by accident, and this is what keeps that true once Phase 4 gives the
// page real catalogue data to render.
describe("looking at Settings never probes a harness", () => {
  beforeEach(() => invoked.mockReset());

  const probes = () =>
    invoked.mock.calls.map(([cmd]) => cmd as string).filter((cmd) => cmd.startsWith("refresh_model_catalog"));

  it("issues no probe on open", async () => {
    const { container } = mount();
    await waitFor(() => expect(container.textContent).toContain("Claude"));
    expect(probes()).toEqual([]);
  });

  it("issues no probe on opening a harness page either", async () => {
    await open(mount(), /Claude/);
    expect(probes()).toEqual([]);
  });
});
