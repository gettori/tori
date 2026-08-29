import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, fireEvent, screen, within } from "@solidjs/testing-library";

// Every call this surface makes to the backend, recorded. The draft's promise is
// that none of them starts a chat: no `chat_spawn`, so no child process, no
// claimed session id and nothing registered as live for a chat nobody has sent
// to yet. Asserting it here rather than by counting processes is what makes it a
// property of the code instead of an observation about one run.
const invoke = vi.fn(async (cmd: string) => {
  if (cmd === "list_agents") return ADAPTERS;
  if (cmd === "agent_health") return HEALTH;
  if (cmd === "model_catalogs") return CATALOGS;
  if (cmd === "refresh_model_catalog") return CATALOGS[0];
  // Reached through the model rows' context windows. An empty map is the honest
  // answer for a machine that has never fetched them.
  if (cmd === "model_context_caps") return {};
  return undefined;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...(a as [string])) }));

// What this project last chatted as. The store itself reads a settings file
// through the backend, and what the draft does with the answer is the part
// under test, so only the one accessor is stood in for.
const remembered = vi.hoisted(() => ({
  value: {} as { agent?: string | null; model?: string | null; effort?: string | null; mode?: string | null },
  /** Which agents this install offers. The palette lists what is offered, so a
   *  bench with nothing enabled has an empty left pane. */
  enabled: { claude: true, codex: true } as Record<string, boolean>,
}));
vi.mock("../Settings/settingsStore", async (orig) => {
  const actual = await orig<typeof import("../Settings/settingsStore")>();
  return {
    ...actual,
    chatPrefs: () => remembered.value,
    // A getter: this factory runs once, and the enabled map is per test.
    get settings() {
      return { ...actual.settings, agent: { enabled: remembered.enabled } };
    },
    settingsLoaded: () => true,
  };
});

import ChatDraft from "./ChatDraft";
import {
  clearComposer,
  draftFor,
  hasAutoSend,
  offerToComposer,
  pendingFor,
  selectionBlocks,
  setDraft,
  takeAutoSend,
} from "../../utils/chatCompose";
import { clearDraftPick, draftPick, setDraftOption, setDraftPick } from "../../utils/chatDraftPick";
import { __resetModelCatalogsForTests } from "../../utils/modelCatalog";

// The draft is the state a chat is in before it costs anything: no child, no
// session id, no claim. What these pin is the handover - that the first message
// survives the composer clearing itself, that it is held rather than sent, that
// a second Enter cannot buy a second session - and what the palette in its
// composer bar is allowed to offer before any of that exists.

const TAB = "chat:draft-1";

const chat = {
  transport: "claude_stream_json",
  program: "claude",
  base_args: [],
  session_id_args: [],
  resume_args: [],
  model_args: [],
  effort_args: [],
  mode_args: [],
  add_dir_args: [],
  modes: [
    { id: "plan", label: "Plan", hint: "Read only", args: [] },
    // Gated: measured on claude 2.1.220, `--permission-mode auto` on a model
    // without the flag exits 0 and silently runs `default`, so the row is
    // offered only to a model that declares it.
    { id: "auto", label: "Auto", hint: "", args: [], requires: "supportsAutoMode" },
  ],
  effort: [],
  acp: { serve_client_fs: false },
};

const ADAPTERS = [
  { id: "claude", label: "Claude", program: "claude", base_args: [], yolo_args: [], resume_args: [], parser_kind: null, running_pattern: null, pty_quiet_ms: 2000, chat },
  // An ACP adapter declares no modes at all, on purpose: they are the agent's
  // own answer and arrive with a session. That empty table is what left the
  // draft reading "this agent has no modes" for every one of them.
  { id: "codex", label: "Codex", program: "codex", base_args: [], yolo_args: [], resume_args: [], parser_kind: null, running_pattern: null, pty_quiet_ms: 2000, chat: { ...chat, program: "codex", modes: [] } },
];

const HEALTH = [
  { id: "claude", label: "Claude", program: "claude", status: "versionMatch", signIn: "signedIn", account: null, apiKeySource: null, path: "/bin/claude", version: "1", verifiedAgainst: "1", sessionsDir: null, sessionsDirExists: false, hooks: false, needsYou: false, overridePath: null },
  { id: "codex", label: "Codex", program: "codex", status: "notFound", signIn: "unknown", account: null, apiKeySource: null, path: null, version: null, verifiedAgainst: null, sessionsDir: null, sessionsDirExists: false, hooks: false, needsYou: false, overridePath: null },
];

const row = (value: string, displayName: string) => ({
  value,
  resolvedModel: value,
  displayName,
  description: "",
  supportsEffort: false,
  supportedEffortLevels: [],
  supportsAutoMode: false,
  supportsFastMode: false,
  supportsAdaptiveThinking: false,
});

/** The two rows a mirror exists for: a select and a toggle no bespoke control
 *  claims. Cached from a probe, which is the only place a draft can read them. */
const OPTIONS = [
  {
    id: "collaboration_mode",
    name: "Collaboration mode",
    description: "How much it checks in",
    category: "",
    kind: "select",
    current: "solo",
    choices: [
      { value: "solo", label: "Solo", description: "" },
      { value: "pair", label: "Pair", description: "" },
    ],
  },
  { id: "web_search", name: "Web search", description: "", category: "", kind: "boolean", value: false },
  // The mode selector's own row. Categorized, so the mirror leaves it to the
  // bespoke control, and it is where the mode a session opens in comes from.
  {
    id: "approval_policy",
    name: "Mode",
    description: "",
    category: "mode",
    kind: "select",
    current: "agent",
    choices: [
      { value: "read-only", label: "Read Only", description: "" },
      { value: "agent", label: "Agent", description: "" },
    ],
  },
];

/** What a *second* ACP model answers with. Measured: both agents re-cut their
 *  options per model, so the probe now switches to each one and caches its own
 *  set. This row has withdrawn the toggle the first row publishes. */
const NARROWER = OPTIONS.filter((o) => o.id !== "web_search");

/** The modes Codex publishes on `session/new`, as the probe cached them. */
const ACP_MODES = [
  { id: "read-only", label: "Read Only", hint: "Ask before writing" },
  { id: "agent", label: "Agent", hint: "" },
];

/** Claude publishes no options at all, so Sway assembles them per model row.
 *  Only the annotated one has anything to say, which is what makes a model
 *  switch re-cut the set rather than leave it. */
const FAST_MODE = {
  id: "fast_mode",
  name: "Fast mode",
  description: "",
  category: "",
  disabled: true,
  note: "Fast mode is not available in the Agent SDK",
  kind: "boolean",
  value: false,
};

const CATALOGS = [
  {
    agentId: "claude",
    state: "probed",
    catalogue: {
      version: "1",
      probedAtMs: 0,
      models: [
        { ...row("sonnet", "Sonnet"), options: [] },
        { ...row("haiku", "Haiku"), options: [FAST_MODE] },
        { ...row("opus", "Opus"), supportsAutoMode: true, options: [] },
      ],
      modes: [],
      account: null,
      // From the same handshake the models came from. Skills are already in
      // this list on the wire, so there is one source rather than two.
      commands: [
        { name: "review", description: "Review the diff", argumentHint: "", aliases: [] },
        { name: "dataviz", description: "A skill, which the CLI lists here too", argumentHint: "", aliases: [] },
      ],
    },
    lastFailure: null,
  },
  {
    agentId: "codex",
    state: "probed",
    catalogue: {
      version: "1",
      probedAtMs: 0,
      // Two rows carrying **different** sets, which is what the probe writes now
      // that it switches model per row rather than copying one session's answer
      // onto all of them.
      models: [
        { ...row("gpt-5", "GPT-5"), options: OPTIONS },
        { ...row("gpt-5-mini", "GPT-5 mini"), options: NARROWER },
      ],
      // An ACP agent's commands reach the cache the same way, though they come
      // from a notification after `session/new` rather than from any response.
      // Not asserted through this draft: codex is the fixture's not-found
      // agent, so its composer is disabled and types nothing. What the menu
      // does with a list is agent-agnostic (`cachedCommands`), and that an ACP
      // update becomes one is pinned in Rust.
      commands: [{ name: "handoff", description: "Package this for a fresh session", argumentHint: "", aliases: [] }],
      modes: ACP_MODES,
      options: OPTIONS,
      account: null,
    },
    lastFailure: null,
  },
];

/** Let the store reads settle. They are promise chains rather than timers, so
 *  three microtask turns is enough and a fake clock is not needed. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** What the draft asked the backend, minus the reads every surface makes. */
const chatCalls = () => invoke.mock.calls.map(([cmd]) => cmd).filter((cmd) => cmd.startsWith("chat_"));

beforeEach(() => {
  __resetModelCatalogsForTests();
});

afterEach(() => {
  clearComposer(TAB);
  clearDraftPick(TAB);
  remembered.value = {};
  remembered.enabled = { claude: true, codex: true };
  invoke.mockClear();
});

function setup(over: Partial<Parameters<typeof ChatDraft>[0]> = {}) {
  const onStart = vi.fn();
  const onSelectAgent = vi.fn();
  const result = render(() => (
    <ChatDraft
      tabId={TAB}
      cwd="/work/repo"
      workspace="/work/repo"
      active={true}
      agentId="claude"
      onSelectAgent={onSelectAgent}
      onStart={onStart}
      {...over}
    />
  ));
  const input = result.container.querySelector("textarea") as HTMLTextAreaElement;
  const pills = () => [...result.container.querySelectorAll("button")] as HTMLButtonElement[];
  const openPalette = () => {
    fireEvent.click(screen.getByLabelText("Model"));
    return screen.getByRole("combobox") as HTMLInputElement;
  };
  return { ...result, input, pills, openPalette, onStart, onSelectAgent };
}

describe("a chat draft costs nothing", () => {
  // The whole point of opening a chat lazily: a tab opened and never used spawns
  // no agent, mints no session id and claims nothing, so it cannot contend with
  // a session running anywhere else either.
  it("starts no chat at all while it is a draft", () => {
    setup();
    expect(chatCalls()).toEqual([]);
  });

  // The reads are the cache, not the binaries: `list_agents`, `agent_health` and
  // `model_catalogs` all answer from disk. The one process a draft is allowed to
  // start is a probe of the agent it would actually run.
  it("reads the cache and probes only the agent it would start", async () => {
    setup();
    await settle();
    const probes = invoke.mock.calls.filter(([cmd]) => cmd === "refresh_model_catalog");
    expect(probes.length).toBeLessThanOrEqual(1);
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toContain("model_catalogs");
  });

  // Typing is not starting. The message is composed entirely client-side, and
  // only Enter decides there is going to be a session.
  it("starts none while it is being typed into", () => {
    const { input } = setup();
    fireEvent.input(input, { target: { value: "thinking about it" } });
    expect(chatCalls()).toEqual([]);
  });

  // The draft hands over rather than sending: spawning, claiming and sending all
  // belong to the surface that has a session.
  it("asks its tab to start one rather than starting anything itself", async () => {
    const { input, onStart } = setup();
    fireEvent.input(input, { target: { value: "go" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(chatCalls()).toEqual([]);
  });
});

describe("a chat draft's first send", () => {
  it("holds the message instead of sending it, and asks for a session", async () => {
    const { input, onStart } = setup();
    fireEvent.input(input, { target: { value: "start here" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Held under the tab, which is what survives the surface being replaced.
    expect(takeAutoSend(TAB)).toBe("start here");
    // Deferred one microtask so the composer finishes its own submit first.
    await Promise.resolve();
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  // The composer empties itself the moment `onSend` returns. A flag plus the
  // draft text would lose the message to that clear; holding the text is what
  // makes the handover survive it.
  it("keeps the message even though the composer clears itself", async () => {
    const { input } = setup();
    fireEvent.input(input, { target: { value: "do not lose me" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();

    expect(draftFor(TAB)).toBe("");
    expect(takeAutoSend(TAB)).toBe("do not lose me");
  });

  // One session per send, not one per keypress: the surface is on its way out
  // for the whole window between Enter and the swap being drawn.
  it("starts one session however many times Enter is pressed", async () => {
    const { input, onStart } = setup();
    fireEvent.input(input, { target: { value: "go" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();

    expect(onStart).toHaveBeenCalledTimes(1);
  });

  // An empty send would cost a process and a session id for nothing.
  it("does not start a session on an empty composer", async () => {
    const { input, onStart } = setup();
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();

    expect(onStart).not.toHaveBeenCalled();
    expect(hasAutoSend(TAB)).toBe(false);
  });

  // Attachments alone are a real thing to send, and the chips ride to the
  // session the same way the text does.
  it("starts on attachments alone", async () => {
    offerToComposer(TAB, selectionBlocks("/work/repo/a.ts", 1, 4, "x"));
    const { input, onStart } = setup();
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(takeAutoSend(TAB)).toBe("");
    // Left for the session to take with its first turn, not consumed here.
    expect(pendingFor(TAB)).toHaveLength(1);
  });

  it("shows what a chat is typed into before it exists", () => {
    setDraft(TAB, "already typed");
    const { input } = setup();
    expect(input.value).toBe("already typed");
  });

  // Filed under the tab and cleared only when the tab goes, so every unmount
  // that is not a close - a tab switch, the swap a first send makes, the swap
  // back a failed one makes - leaves the text where the user put it.
  it("still has what was typed after its surface has been torn down", () => {
    const first = setup();
    fireEvent.input(first.input, { target: { value: "half a thought" } });
    first.unmount();

    const again = setup();
    expect(again.input.value).toBe("half a thought");
  });

  // The reason a first send came back, rendered where the decision about what to
  // do next gets made.
  it("says why a first send never reached a session", () => {
    const { container } = setup({ error: "that agent is not installed." });
    expect(container.textContent).toContain("that agent is not installed.");
  });

  it("says nothing at all when there is nothing to report", () => {
    const { container } = setup();
    expect(container.textContent).not.toContain("never");
  });
});

// `/` in a new chat opened on nothing at all: a draft has no session, and the
// commands were treated as unknowable until one existed. They ride the same
// handshake the models do, and the draft already reads that cache for its model
// picker.
describe("a chat draft's slash commands", () => {
  it("completes from the agent's last handshake, skills included", async () => {
    const { input } = setup();
    await settle();

    fireEvent.input(input, { target: { value: "/dat" } });

    // A skill, which the CLI publishes in the same list as its commands.
    expect(await screen.findByText("/dataviz")).toBeTruthy();
  });

  it("offers the agent's own list, not another agent's", async () => {
    // The catalogue the menu reads is the one for the agent this draft would
    // start, so it never completes into a command that agent does not publish.
    const { input } = setup({ agentId: "codex" });
    await settle();

    fireEvent.input(input, { target: { value: "/rev" } });

    expect(screen.queryByText("/review")).toBeNull();
  });

});

describe("a chat draft's pick", () => {
  it("offers the agents this install can start, from the cache alone", async () => {
    const { openPalette } = setup();
    await settle();
    openPalette();
    // Scoped to the lists: the models pane names its agent in its own heading,
    // so "Claude" appears there too.
    const agents = within(screen.getByRole("listbox", { name: "Agents" }));
    expect(agents.getByText("Claude")).toBeTruthy();
    // Codex is turned on and its binary is missing, so nothing offers it. The
    // palette is a list of things a send can start, not of what exists.
    expect(agents.queryByText("Codex")).toBeNull();
    expect(within(screen.getByRole("listbox", { name: "Models" })).getByText("Sonnet")).toBeTruthy();
    expect(chatCalls()).toEqual([]);
  });

  // With nothing to offer the palette says which setting to go and change,
  // rather than the filter's "no agents match" about a list that was never
  // going to have any.
  it("names the setting when this install offers nothing", async () => {
    remembered.enabled = {};
    const { openPalette } = setup();
    await settle();
    openPalette();
    const agents = within(screen.getByRole("listbox", { name: "Agents" }));
    expect(agents.queryByText("Claude")).toBeNull();
    expect(agents.getByText("No agents enabled. Turn one on in Settings.")).toBeTruthy();
  });

  it("records a model on the tab rather than sending it anywhere", async () => {
    const { openPalette } = setup();
    await settle();
    const filter = openPalette();
    // One press: a draft opens already naming the agent's first row, so the
    // cursor starts there and steps to the second. The second row is the point,
    // since committing the first would pass whether or not the pick was read.
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    fireEvent.keyDown(filter, { key: "Enter" });

    expect(draftPick(TAB).model).toBe("haiku");
    expect(chatCalls()).toEqual([]);
  });

  // The second draft in a project opens where the last one left off, which is
  // the whole of what the remembered picks buy.
  it("opens on the model and mode this project last used", async () => {
    remembered.value = { agent: "claude", model: "haiku", mode: "plan" };
    setup();
    await settle();

    expect(draftPick(TAB).model).toBe("haiku");
    expect(draftPick(TAB).mode).toBe("plan");
    // The pill reads the catalogue row, so a restored value that no row matches
    // would leave it on its placeholder rather than showing a stored string.
    expect(screen.getByText("Haiku")).toBeTruthy();
    expect(chatCalls()).toEqual([]);
  });

  // A settings file outlives the catalogue it was written against: an agent can
  // drop a model, and a project's stored pick can name another agent's model
  // entirely (the harness is remembered beside it, but the file is old or the
  // adapter has gone). Either way the draft opens on nothing rather than on a
  // row the send would be refused for.
  // Dropped, not sent: the stored id belongs to another agent's catalogue. What
  // takes its place is this agent's own first row rather than nothing, so the
  // pill names a model the draft would really start on.
  it("falls to the agent's default when the remembered model is not offered", async () => {
    remembered.value = { model: "gpt-5" };
    setup();
    await settle();

    expect(draftPick(TAB).model).toBe("sonnet");
  });

  it("opens on the agent's default when nothing was remembered at all", async () => {
    setup();
    await settle();

    expect(draftPick(TAB).model).toBe("sonnet");
  });

  it("leaves a pick the user has already made alone", async () => {
    remembered.value = { model: "haiku" };
    setDraftPick(TAB, { model: "sonnet" });
    setup();
    await settle();

    expect(draftPick(TAB).model).toBe("sonnet");
  });

  it("keeps mode and effort when only the model changes", async () => {
    setDraftPick(TAB, { model: "sonnet", mode: "plan", effort: "high" });
    const { openPalette } = setup();
    await settle();
    const filter = openPalette();
    fireEvent.input(filter, { target: { value: "haiku" } });
    fireEvent.keyDown(filter, { key: "Enter" });

    expect(draftPick(TAB)).toEqual({ model: "haiku", mode: "plan", effort: "high", optionValues: {} });
  });

  // Mode and effort name things the *old* agent published, so they leave with
  // it. Switching *off* a broken agent is the same path: only the agent being
  // moved to has to be selectable.
  it("drops mode and effort when the agent changes", async () => {
    setDraftPick(TAB, { model: "gpt-5", mode: "plan", effort: "high" });
    const { openPalette, onSelectAgent } = setup({ agentId: "codex" });
    await settle();
    const filter = openPalette();
    fireEvent.input(filter, { target: { value: "haiku" } });
    fireEvent.keyDown(filter, { key: "Enter" });

    expect(onSelectAgent).toHaveBeenCalledWith("claude");
    expect(draftPick(TAB)).toEqual({ model: "haiku", mode: null, effort: null, optionValues: {} });
  });

  // A broken default keeps its selection: switching away for the user would hide
  // the problem rather than solve it, and the pill is where it is legible.
  // Codex is enabled here and its binary is missing, which is the one way a
  // draft can still be pointed at an agent nothing offers: the tab outlived the
  // install. The palette drops it; the composer is where it says why.
  it("cannot be sent on a broken agent, and says which one and why", async () => {
    const { input, onStart, container } = setup({ agentId: "codex" });
    await settle();
    expect(container.textContent).toContain("Codex is not installed");

    fireEvent.input(input, { target: { value: "go" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();
    expect(onStart).not.toHaveBeenCalled();
    expect(hasAutoSend(TAB)).toBe(false);
  });

  // Arrowing past six agents must not launch six binaries: the highlight is
  // debounced, so only where the cursor came to rest is asked.
  it("does not probe every agent a keyboard sweep passes over", async () => {
    vi.useFakeTimers();
    try {
      const { openPalette } = setup();
      const filter = openPalette();
      fireEvent.keyDown(filter, { key: "Tab" });
      const before = invoke.mock.calls.filter(([cmd]) => cmd === "refresh_model_catalog").length;
      for (let i = 0; i < 6; i++) fireEvent.keyDown(filter, { key: "ArrowDown" });
      vi.advanceTimersByTime(400);
      const after = invoke.mock.calls.filter(([cmd]) => cmd === "refresh_model_catalog").length;
      expect(after - before).toBeLessThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The mode selector before there is a session to ask. Its rows and the mode it
// shows come from two different halves of the cache depending on the agent,
// which is the whole reason one resolver owns the question.
describe("a chat draft's mode", () => {
  const modePill = () => screen.getByLabelText("Permission mode");

  // The bug this closes: `capabilitiesFor` was called without its live list, so
  // an ACP agent's empty `[[chat.modes]]` was the only source and the selector
  // never rendered at all.
  it("offers an ACP agent its own modes and names the one it opens in", async () => {
    setup({ agentId: "codex" });
    await settle();

    expect(modePill().textContent).toContain("Agent");
    expect(modePill().textContent).not.toContain("Mode");
  });

  // Claude publishes no modes on the wire, so both halves come off the adapter.
  // Either way the pill describes a mode rather than reading "Mode".
  it("shows a declared-mode agent its adapter's default", async () => {
    setup();
    await settle();

    expect(modePill().textContent).toContain("Plan");
    expect(modePill().textContent).not.toContain("Mode");
  });

  it("renders no selector at all for an agent with neither", async () => {
    setup({ agentId: "codex" });
    // Before the catalogue lands there is nothing cached and codex declares
    // none, which is the same state an unprobed agent stays in.
    expect(screen.queryByLabelText("Permission mode")).toBeNull();
  });

  // The gate is only worth anything if the model control cannot walk around it:
  // a mode gated on a capability stays picked when the row disappears, and the
  // CLI accepts it, exits 0, and silently runs something else.
  it("drops a mode the newly picked model does not support", async () => {
    setDraftPick(TAB, { model: "opus", mode: "auto" });
    const { openPalette } = setup();
    await settle();
    const filter = openPalette();
    fireEvent.input(filter, { target: { value: "haiku" } });
    fireEvent.keyDown(filter, { key: "Enter" });

    expect(draftPick(TAB).model).toBe("haiku");
    // The default among what is still offered, rather than the adapter's
    // outright: a gated default would put the draft straight back here.
    expect(draftPick(TAB).mode).toBe("plan");
  });
});

// The levers the agent published that Sway has no control of its own for. A
// draft reads them from the probe cache, since there is no session to ask.
describe("a chat draft's mirrored options", () => {
  it("shows the agent's own levers from the cache, with nothing spawned", async () => {
    const { queryAllByLabelText } = setup({ agentId: "codex" });
    await settle();

    // A two-choice select is a toggle, and an icon-only one carries its name
    // in `aria-label` rather than on screen.
    expect(queryAllByLabelText(/^Collaboration mode/)).toHaveLength(1);
    expect(chatCalls()).toEqual([]);
  });

  it("renders nothing at all for a catalogue that publishes none", async () => {
    const { container, queryAllByLabelText } = setup();
    await settle();

    expect(container.textContent).not.toContain("Web search");
    expect(queryAllByLabelText(/^Collaboration mode/)).toHaveLength(0);
  });

  // Nothing echoes a switch back before there is a session, so the flip has to
  // be shown from the pick itself or the control moves nothing on screen.
  it("shows a flipped toggle flipped, and records it on the tab", async () => {
    const { getByLabelText } = setup({ agentId: "codex" });
    await settle();
    fireEvent.click(getByLabelText("Web search"));

    expect(getByLabelText("Web search").getAttribute("aria-pressed")).toBe("true");
    expect(draftPick(TAB).optionValues).toEqual({ web_search: true });
    expect(chatCalls()).toEqual([]);
  });

  it("shows a picked choice on the pill, not the agent's own current one", async () => {
    const { getByLabelText } = setup({ agentId: "codex" });
    await settle();
    // Two choices, so it is a toggle and the pick is the flip. The agent's own
    // current value is `solo`; what the control has to show is `pair`.
    fireEvent.click(getByLabelText("Collaboration mode: Solo"));

    expect(getByLabelText("Collaboration mode: Pair").getAttribute("aria-pressed")).toBe("true");
    expect(draftPick(TAB).optionValues).toEqual({ collaboration_mode: "pair" });
  });

  // A restored draft outlives the catalogue it was picked against, the same way
  // a remembered model does. Dropped rather than shown as a control over nothing.
  it("drops a stored value for a lever this agent no longer publishes", async () => {
    setDraftPick(TAB, { optionValues: { gone: true, web_search: true } });
    setup({ agentId: "codex" });
    await settle();

    expect(draftPick(TAB).optionValues).toEqual({ web_search: true });
  });

  // Shape, not just id: a select whose choice was withdrawn is as dead as an
  // option that was, and sending it would be answered by silence.
  it("drops a stored choice the agent has since withdrawn", async () => {
    setDraftPick(TAB, { optionValues: { collaboration_mode: "swarm" } });
    setup({ agentId: "codex" });
    await settle();

    expect(draftPick(TAB).optionValues).toEqual({});
  });

  // Claude's levers are a function of the model, so the set has to be re-cut
  // when the pick moves rather than left showing the last model's.
  it("follows the picked model when the levers depend on it", async () => {
    setDraftPick(TAB, { model: "sonnet" });
    const { queryByLabelText, openPalette } = setup();
    await settle();
    expect(queryByLabelText("Fast mode")).toBeNull();

    const filter = openPalette();
    fireEvent.input(filter, { target: { value: "haiku" } });
    fireEvent.keyDown(filter, { key: "Enter" });

    expect(queryByLabelText("Fast mode")).not.toBeNull();
  });

  // The ACP half of the same rule. An agent's options used to be per session
  // and shared by every row, so a draft showed one model's set whatever was
  // picked. Measured 2026-08-21: both agents re-cut their options per model, so
  // each row now carries its own and the mirror has something to re-cut to.
  it("follows the picked model for an ACP agent too", async () => {
    setDraftPick(TAB, { model: "gpt-5" });
    const { queryAllByLabelText } = setup({ agentId: "codex" });
    await settle();
    expect(queryAllByLabelText("Web search")).toHaveLength(1);
    expect(queryAllByLabelText(/^Collaboration mode/)).toHaveLength(1);

    setDraftPick(TAB, { model: "gpt-5-mini" });
    await settle();

    expect(queryAllByLabelText("Web search")).toHaveLength(0);
    // The lever both rows publish stays, so this is a re-cut rather than a clear.
    expect(queryAllByLabelText(/^Collaboration mode/)).toHaveLength(1);
  });

  // And a value picked against the first row goes with the lever that carried
  // it, on the same rule `keptOptionValues` already applies to a stale cache.
  it("drops a picked value the newly picked ACP model no longer publishes", async () => {
    setDraftPick(TAB, { model: "gpt-5" });
    const { getByLabelText } = setup({ agentId: "codex" });
    await settle();
    fireEvent.click(getByLabelText("Web search"));
    expect(draftPick(TAB).optionValues).toEqual({ web_search: true });

    setDraftPick(TAB, { model: "gpt-5-mini" });
    await settle();

    expect(draftPick(TAB).optionValues).toEqual({});
  });

  // A value picked against one model is not a claim about the next one.
  it("drops a picked value the newly picked model does not publish", async () => {
    setDraftPick(TAB, { model: "haiku" });
    const { openPalette, getByLabelText } = setup();
    await settle();
    // Enabled here only because the fixture's row is; the point is the drop.
    setDraftOption(TAB, "fast_mode", true);
    expect(getByLabelText("Fast mode")).toBeTruthy();

    const filter = openPalette();
    fireEvent.input(filter, { target: { value: "sonnet" } });
    fireEvent.keyDown(filter, { key: "Enter" });
    await settle();

    expect(draftPick(TAB).optionValues).toEqual({});
  });
});
