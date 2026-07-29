import { describe, it, expect } from "vitest";
import bundled from "../../dev/fixtures/agents/bundled.json";
import {
  resumeCommand,
  applyTemplate,
  chatCapable,
  effortArgsFor,
  effortLevelsFor,
  modeArgsFor,
  modelArgsFor,
  FALLBACK_AGENTS,
  type Agent,
  type ChatConfig,
} from "./agents";

const agent = (program: string, resume_args: string[]): Agent => ({
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
    expect(resumeCommand(agent("pi", ["--session", "{file}"]), { id: "abc", file: "/s/abc.jsonl" })).toBe(
      "pi --session /s/abc.jsonl",
    );
  });

  it("quotes a path with a space, so the pasted command survives shell re-parsing", () => {
    expect(resumeCommand(agent("pi", ["--session", "{file}"]), { id: "a", file: "/My Docs/a.jsonl" })).toBe(
      "pi --session '/My Docs/a.jsonl'",
    );
  });

  it("quotes an embedded single quote", () => {
    expect(resumeCommand(agent("pi", ["--session", "{file}"]), { id: "a", file: "/it's/a.jsonl" })).toBe(
      `pi --session '/it'\\''s/a.jsonl'`,
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
describe("FALLBACK_AGENTS agrees with the bundled adapters", () => {
  const resolved = bundled as unknown as Agent[];

  it("covers exactly the bundled ids", () => {
    expect(FALLBACK_AGENTS.map((a) => a.id).sort()).toEqual(resolved.map((a) => a.id).sort());
  });

  // The fields the pre-resolve paint actually uses. A drift in any of them is
  // a visible first-paint flicker or, for running_pattern, a wrong liveness
  // probe.
  it("matches field-for-field on everything the first paint reads", () => {
    for (const want of resolved) {
      const got = FALLBACK_AGENTS.find((a) => a.id === want.id);
      expect(got, `no fallback entry for ${want.id}`).toBeDefined();
      if (!got) continue;
      expect(got.label, `${want.id}.label`).toBe(want.label);
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
    for (const a of FALLBACK_AGENTS) {
      expect(a.chat, `${a.id} must not duplicate the chat table`).toBeNull();
      expect(chatCapable(a)).toBe(false);
    }
  });
});

describe("the bundled chat tables", () => {
  const resolved = bundled as unknown as Agent[];
  const claude = resolved.find((a) => a.id === "claude")!;

  it("makes claude chat-capable and leaves the others PTY-only", () => {
    expect(chatCapable(claude)).toBe(true);
    for (const id of ["pi", "opencode"]) {
      expect(chatCapable(resolved.find((a) => a.id === id)!), `${id} should stay PTY-only`).toBe(false);
    }
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
    expect(chat.effort.map((e) => e.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
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

  it("gates auto on the capability the catalogue reports, and flags the permissive mode", () => {
    const chat = claude.chat as ChatConfig;
    expect(chat.modes.find((m) => m.id === "auto")?.requires).toBe("supportsAutoMode");
    expect(chat.modes.filter((m) => m.permissive_caveat).map((m) => m.id)).toEqual(["bypassPermissions"]);
  });
});

describe("effortLevelsFor", () => {
  const claude = (bundled as unknown as Agent[]).find((a) => a.id === "claude")!;
  const chat = claude.chat as ChatConfig;

  it("resolves a model's levels to real entries with args", () => {
    const levels = effortLevelsFor(chat, "claude-opus-5");
    expect(levels.map((l) => l.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(levels.every((l) => l.args.length > 0)).toBe(true);
  });

  // Empty is what hides the control, so it must not fall back to the full set.
  it("is empty for a model declaring no levels", () => {
    expect(effortLevelsFor(chat, "claude-haiku-4-5-20251001")).toEqual([]);
  });

  it("is empty for an unknown model rather than throwing", () => {
    expect(effortLevelsFor(chat, "not-a-model")).toEqual([]);
  });
});

// The same precedence rule the backend applies, mirrored so the two cannot
// resolve the same adapter differently.
describe("mode/effort/model arg resolution", () => {
  const claude = (bundled as unknown as Agent[]).find((a) => a.id === "claude")!;
  const chat = claude.chat as ChatConfig;

  it("uses an entry's own args when it declares them", () => {
    expect(modeArgsFor(chat, "plan")).toEqual(["--permission-mode", "plan"]);
    expect(effortArgsFor(chat, "xhigh")).toEqual(["--effort", "xhigh"]);
  });

  it("fills the table template for an entry with no args of its own", () => {
    const bare: ChatConfig = {
      ...chat,
      modes: [{ id: "plan", label: "Plan", hint: "", args: [] }],
      effort: [{ id: "low", label: "Low", args: [] }],
    };
    expect(modeArgsFor(bare, "plan")).toEqual(["--permission-mode", "plan"]);
    expect(effortArgsFor(bare, "low")).toEqual(["--effort", "low"]);
  });

  it("resolves a model from the template", () => {
    expect(modelArgsFor(chat, "claude-opus-5")).toEqual(["--model", "claude-opus-5"]);
  });

  // Null, not a filled template: sending args for a mode the adapter never
  // declared would be inventing a capability.
  it("is null for an id the adapter never declared", () => {
    expect(modeArgsFor(chat, "not_a_mode")).toBeNull();
    expect(effortArgsFor(chat, "not_a_level")).toBeNull();
    expect(modelArgsFor(chat, "not_a_model")).toBeNull();
  });

  // The frontend and backend must resolve identically, so the bundled
  // adapter's two forms are checked to agree here as well.
  it("agrees with the table template on every bundled entry", () => {
    for (const m of chat.modes) {
      expect(modeArgsFor(chat, m.id), `mode ${m.id}`).toEqual(["--permission-mode", m.id]);
    }
    for (const e of chat.effort) {
      expect(effortArgsFor(chat, e.id), `effort ${e.id}`).toEqual(["--effort", e.id]);
    }
  });
});
