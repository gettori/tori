import { describe, it, expect } from "vite-plus/test";
import bundled from "../../dev/fixtures/agents/bundled.json";
import {
  resumeCommand,
  applyTemplate,
  chatCapable,
  effortArgsFor,
  modeArgsFor,
  modelArgsFor,
  FALLBACK_ADAPTERS,
  type Adapter,
  type ChatConfig,
} from "./agents";

const agent = (program: string, resume_args: string[]): Adapter => ({
  id: "x",
  label: "X",
  program,
  base_args: [],
  yolo_args: [],
  resume_args,
  parser_kind: "claude_jsonl",
  running_pattern: "",
  pty_quiet_ms: 0,
});

describe("resumeCommand", () => {
  it("fills {id} against the launch binary", () => {
    expect(resumeCommand(agent("claude", ["--resume", "{id}"]), { id: "abc123", file: "/s/abc123.jsonl" })).toBe(
      "claude --resume abc123",
    );
  });

  it("fills {file} for a file-addressed adapter", () => {
    expect(resumeCommand(agent("otheragent", ["--session", "{file}"]), { id: "abc", file: "/s/abc.jsonl" })).toBe(
      "otheragent --session /s/abc.jsonl",
    );
  });

  it("quotes a path with a space, so the pasted command survives shell re-parsing", () => {
    expect(resumeCommand(agent("otheragent", ["--session", "{file}"]), { id: "a", file: "/My Docs/a.jsonl" })).toBe(
      "otheragent --session '/My Docs/a.jsonl'",
    );
  });

  it("quotes an embedded single quote", () => {
    expect(resumeCommand(agent("otheragent", ["--session", "{file}"]), { id: "a", file: "/it's/a.jsonl" })).toBe(
      `otheragent --session '/it'\\''s/a.jsonl'`,
    );
  });

  it("is null for a resume-less adapter", () => {
    expect(resumeCommand(agent("bare", []), { id: "a", file: "/s/a.jsonl" })).toBeNull();
  });
});

describe("applyTemplate", () => {
  it("substitutes both placeholders", () => {
    expect(applyTemplate(["-r", "{id}", "-f", "{file}"], { id: "1", file: "/f" })).toEqual(["-r", "1", "-f", "/f"]);
  });
});

// `bundled.json` is written by the Rust test
// `emit_bundled_adapters_for_the_typescript_fallback`, serialized by the same
// impl `list_agents` uses. So this compares the hand-maintained fallback
// against what the backend genuinely produces, not against a restatement of
// the TOML.
describe("FALLBACK_ADAPTERS agrees with the bundled adapters", () => {
  const resolved = bundled as unknown as Adapter[];

  it("covers exactly the bundled ids", () => {
    expect(FALLBACK_ADAPTERS.map((a) => a.id).sort()).toEqual(resolved.map((a) => a.id).sort());
  });

  // The fields the pre-resolve paint actually uses. A drift in any of them is
  // a visible first-paint flicker or, for running_pattern, a wrong liveness
  // probe.
  it("matches field-for-field on everything the first paint reads", () => {
    for (const want of resolved) {
      const got = FALLBACK_ADAPTERS.find((a) => a.id === want.id);
      expect(got, `no fallback entry for ${want.id}`).toBeDefined();
      if (!got) continue;
      expect(got.label, `${want.id}.label`).toBe(want.label);
      // A first-paint field like the rest: the tab and sidebar glyphs resolve
      // through it before `list_agents` lands.
      expect(got.icon, `${want.id}.icon`).toBe(want.icon);
      expect(got.program, `${want.id}.program`).toBe(want.program);
      expect(got.base_args, `${want.id}.base_args`).toEqual(want.base_args);
      expect(got.yolo_args, `${want.id}.yolo_args`).toEqual(want.yolo_args);
      expect(got.resume_args, `${want.id}.resume_args`).toEqual(want.resume_args);
      expect(got.parser_kind, `${want.id}.parser_kind`).toBe(want.parser_kind);
      expect(got.running_pattern, `${want.id}.running_pattern`).toBe(want.running_pattern);
      expect(got.pty_quiet_ms, `${want.id}.pty_quiet_ms`).toBe(want.pty_quiet_ms);
    }
  });

  // The chat table is deliberately not duplicated into the fallback: nothing
  // on the pre-resolve path reads it, and a stale copy of the model list would
  // be a liability. Pinned so the omission stays a decision rather than
  // looking like a gap somebody should fill in.
  it("deliberately carries no chat table, so a chat surface waits for the real adapter", () => {
    for (const a of FALLBACK_ADAPTERS) {
      expect(a.chat, `${a.id} must not duplicate the chat table`).toBeNull();
      expect(chatCapable(a)).toBe(false);
    }
  });

  // Same reasoning as the chat table, plus one more: which accounts exist is
  // per-user state the fallback cannot know, and guessing "none" would show a
  // sign-in prompt to somebody already signed in.
  it("deliberately carries no accounts table", () => {
    for (const a of FALLBACK_ADAPTERS) {
      expect(a.accounts, `${a.id} must not duplicate the accounts table`).toBeNull();
    }
  });
});

// Schema v3's [accounts]. This is the check that makes the mirror a mirror:
// `component_agent_adapter_registry` records the shape drifting because both
// sides were hand-written and only one got updated.
describe("the accounts table crosses the Rust/TypeScript boundary intact", () => {
  const resolved = bundled as unknown as Adapter[];
  const claude = resolved.find((a) => a.id === "claude")!;

  // The keys Rust's `AccountsConfig` serializes, listed rather than derived: a
  // TypeScript type is erased at runtime, so this literal *is* the mirror. A
  // field added on the Rust side fails here until it is added to the type
  // above, which is the whole point.
  const ACCOUNTS_KEYS = [
    "home_env",
    "login_args",
    "logout_args",
    "whoami_args",
    "whoami_kind",
    "supports_isolation",
  ];

  it("serializes exactly the fields the TypeScript type declares", () => {
    expect(claude.accounts, "claude declares [accounts]").toBeTruthy();
    expect(Object.keys(claude.accounts!).sort()).toEqual([...ACCOUNTS_KEYS].sort());
  });

  it("carries claude's measured values", () => {
    const acc = claude.accounts!;
    expect(acc.home_env).toBe("CLAUDE_CONFIG_DIR");
    // Measured in Phase 0: two profiles held simultaneous logins, because
    // claude namespaces its Keychain service by config dir.
    expect(acc.supports_isolation).toBe(true);
    expect(acc.whoami_args.length).toBeGreaterThan(0);
    expect(acc.login_args.length).toBeGreaterThan(0);
  });

  // An adapter that declares no table is not "signed out", it is unknown, so
  // the frontend must be able to tell those apart. Gemini is the one that ships
  // without a table, because its CLI is not installed anywhere anybody measured.
  it("reports null for an adapter that declares no accounts table", () => {
    expect(resolved.find((a) => a.id === "gemini")!.accounts ?? null).toBeNull();
  });

  // Declaring a table and claiming isolation are two different claims, and only
  // the second is what "add account" is gated on. Codex and OpenCode both
  // declare how they sign in; neither has been measured holding two logins at
  // once, so neither claims isolation and neither offers a second account.
  it("keeps declaring a sign-in separate from claiming two accounts can hold it", () => {
    const declaring = resolved.filter((a) => a.accounts).map((a) => a.id);
    expect(declaring.sort()).toEqual(["claude", "codex", "copilot", "opencode"]);
    const isolating = resolved.filter((a) => a.accounts?.supports_isolation).map((a) => a.id);
    expect(isolating).toEqual(["claude"]);
  });

  // The reason `whoami_kind` exists at all: OpenCode exits 0 whether or not it
  // holds any credentials, so an adapter that read the exit code would report it
  // signed in while its `auth.json` was empty.
  it("gives each measured agent its own answer shape", () => {
    const kinds = Object.fromEntries(
      resolved.filter((a) => a.accounts).map((a) => [a.id, a.accounts!.whoami_kind]),
    );
    expect(kinds).toEqual({
      claude: "claude_json",
      codex: "exit_code",
      // A login command with no probe: copilot documents no non-interactive
      // status command, so its sign-in state is honestly unknown.
      copilot: null,
      opencode: "opencode_credentials",
    });
  });
});

describe("the bundled chat tables", () => {
  const resolved = bundled as unknown as Adapter[];
  const claude = resolved.find((a) => a.id === "claude")!;

  it("makes claude chat-capable, and treats a table-less adapter as PTY-only", () => {
    expect(chatCapable(claude)).toBe(true);
    // A user adapter with no [chat] table is the PTY-only case now that claude
    // is the only bundled one. `chatCapable` must answer for it without
    // guessing, since a chat launch would otherwise have no transport.
    expect(chatCapable({ ...claude, chat: null })).toBe(false);
  });

  it("mirrors the transport and every arg template", () => {
    const chat = claude.chat as ChatConfig;
    expect(chat.transport).toBe("claude_stream_json");
    expect(chat.program).toBe("claude");
    expect(chat.session_id_args).toEqual(["--session-id", "{id}"]);
    expect(chat.resume_args).toEqual(["--resume", "{id}"]);
    expect(chat.model_args).toEqual(["--model", "{model}"]);
    expect(chat.effort_args).toEqual(["--effort", "{effort}"]);
    expect(chat.mode_args).toEqual(["--permission-mode", "{mode}"]);
    expect(chat.add_dir_args).toEqual(["--add-dir", "{dir}"]);
    expect(chat.base_args).toContain("stream-json");
  });

  it("carries the six permission modes and the five effort levels", () => {
    const chat = claude.chat as ChatConfig;
    // The six `--permission-mode` both accepts and honours. `manual` is
    // deliberately absent: the CLI takes it, but its own help calls it an alias
    // for `default` and init reports `default`, so a row would duplicate one.
    expect(chat.modes.map((m) => m.id)).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "auto",
      "dontAsk",
      "bypassPermissions",
    ]);
    // No effort table left: the levels are the agent's, per model. What the
    // adapter declares is the opposite claim, a level the CLI takes and never
    // advertises, and every one of them names the version it was measured on.
    expect(chat.effort_extras.map((e) => e.id)).toEqual(["ultracode"]);
    expect(chat.effort_extras.every((e) => e.measured_on.length > 0)).toBe(true);
  });

  // The menu renders these, so a mode without one is a row that does not say
  // what it does. They are the CLI's own wording, not a paraphrase.
  it("gives every mode a hint, and reads the label from the TOML", () => {
    const chat = claude.chat as ChatConfig;
    expect(chat.modes.every((m) => m.hint.length > 0)).toBe(true);
    // The drift this settles: the TOML said "Ask" while a constant in
    // ModeSelector said "Default" for the same mode. The TOML now wins, and
    // there is no second list to disagree with it.
    expect(chat.modes.find((m) => m.id === "default")?.label).toBe("Ask");
    expect(chat.modes.find((m) => m.id === "auto")?.hint).toContain("classifier");
  });

  it("gates auto on the capability the catalogue reports", () => {
    const chat = claude.chat as ChatConfig;
    expect(chat.modes.find((m) => m.id === "auto")?.requires).toBe("supportsAutoMode");
    // `permissive_caveat` used to be asserted here, on `bypassPermissions`. The
    // adapter no longer declares it, because Tori no longer runs ahead of the
    // mode it warned about. `permissive` replaced it and is not the same claim:
    // that one was about Tori's gate, this one is about what the mode does.
    expect(JSON.stringify(chat.modes)).not.toContain("permissive_caveat");
    expect(chat.modes.filter((m) => m.permissive).map((m) => m.id)).toEqual(["bypassPermissions"]);
  });
});

// `effortLevelsFor` is gone with the model table it read. A model's levels come
// from the agent's own catalogue (`supportedEffortLevels`) and reach the
// control through `pickableModels`; `[[chat.effort]]` now says only how to spell
// a level as args, for whichever levels the catalogue turns out to name.
describe("the adapter declares no models", () => {
  const claude = (bundled as unknown as Adapter[]).find((a) => a.id === "claude")!;
  const chat = claude.chat as ChatConfig;

  it("names no model at all, and no longer annotates one either", () => {
    expect(chat).not.toHaveProperty("models");
    // `[[chat.annotations]]` went the same way and for the same reason: the
    // handshake publishes `supportsFastMode` per model, so the table was
    // restating the CLI in a spelling the CLI does not use.
    expect(chat).not.toHaveProperty("annotations");
  });
});

// The same precedence rule the backend applies, mirrored so the two cannot
// resolve the same adapter differently.
describe("mode/effort/model arg resolution", () => {
  const claude = (bundled as unknown as Adapter[]).find((a) => a.id === "claude")!;
  const chat = claude.chat as ChatConfig;

  it("uses an entry's own args when it declares them", () => {
    expect(modeArgsFor(chat, "plan")).toEqual(["--permission-mode", "plan"]);
    expect(effortArgsFor(chat, "xhigh")).toEqual(["--effort", "xhigh"]);
  });

  it("fills the table template for an entry with no args of its own", () => {
    const bare: ChatConfig = {
      ...chat,
      modes: [{ id: "plan", label: "Plan", hint: "", args: [] }],
    };
    expect(modeArgsFor(bare, "plan")).toEqual(["--permission-mode", "plan"]);
    // Effort has only the template now, so any level fills it, including one
    // no build has heard of. That is the point: the levels come from the
    // agent's catalogue, and a level that resolved to nothing here would spawn
    // the session flagless with the pill still showing it.
    expect(effortArgsFor(bare, "a-level-no-toml-mentions")).toEqual([
      "--effort",
      "a-level-no-toml-mentions",
    ]);
  });

  it("resolves a model from the template", () => {
    expect(modelArgsFor(chat, "claude-opus-5")).toEqual(["--model", "claude-opus-5"]);
  });

  // Null, not a filled template: sending args for a mode the adapter never
  // declared would be inventing a capability.
  it("is null for a mode the adapter never declared", () => {
    expect(modeArgsFor(chat, "not_a_mode")).toBeNull();
    // Effort is null only for an adapter with no template at all, whose levels
    // are session options set after open rather than argv.
    expect(effortArgsFor({ ...chat, effort_args: [] }, "low")).toBeNull();
  });

  // Models are the exception, and deliberately: there is no declared list to be
  // unknown to. Gating here meant a model the CLI offered but the TOML lacked
  // produced no `--model` flag and silently ran something else.
  it("fills the model template for any id, because the catalogue is the check", () => {
    expect(modelArgsFor(chat, "a-model-no-toml-mentions")).toEqual([
      "--model",
      "a-model-no-toml-mentions",
    ]);
  });

  // The frontend and backend must resolve identically, so the bundled
  // adapter's two forms are checked to agree here as well.
  it("agrees with the table template on every bundled entry", () => {
    for (const m of chat.modes) {
      expect(modeArgsFor(chat, m.id), `mode ${m.id}`).toEqual(["--permission-mode", m.id]);
    }
    for (const level of ["low", "max", "ultracode", "a-level-no-build-has-seen"]) {
      expect(effortArgsFor(chat, level), `effort ${level}`).toEqual(["--effort", level]);
    }
  });
});

// Which rungs each bundled adapter declares, read off the same generated
// fixture the fallback is checked against. A rung is declared only in the phase
// that builds a read path for it, so this list is what Tori can climb today,
// not what the agents are capable of.
describe("the bundled usage ladders", () => {
  const resolved = bundled as unknown as Adapter[];

  it("gives claude the free rung then the opt-in one, and codex the read Tori schedules", () => {
    const ladders = Object.fromEntries(
      resolved.filter((a) => a.usage).map((a) => [a.id, a.usage!.sources]),
    );
    expect(ladders).toEqual({ claude: ["sessions", "token"], codex: ["cli"] });
  });

  // Declaration order is the ladder's order, and the free rung has to come
  // first: `sources[0]` is what an account nobody has answered for resolves to,
  // so a token read would otherwise happen without anybody opting in.
  it("puts claude's free rung ahead of the one that raises a Keychain prompt", () => {
    const claude = resolved.find((a) => a.id === "claude")!;
    expect(claude.usage!.sources[0]).toBe("sessions");
  });

  // Codex forwards no rate limits over ACP, so `cli` is first because it is the
  // only one, and an unanswered install resolves to it rather than to off.
  it("resolves codex to its first declared rung", () => {
    const codex = resolved.find((a) => a.id === "codex")!;
    expect(codex.usage!.sources[0]).toBe("cli");
    expect(codex.usage_reason ?? null).toBeNull();
  });

  it("says why for an adapter that offers none, rather than looking like a gap", () => {
    for (const a of resolved.filter((x) => !x.usage)) {
      expect(a.usage_reason, `${a.id} must say why it offers no source`).toBeTruthy();
    }
  });
});
