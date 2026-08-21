// Mirrors src-tauri/src/agents.rs's `AgentAdapter` (the JSON `list_agents`
// returns). Backend-only fields (discovery dir, filename regex) aren't
// exposed; everything else the frontend needs to launch/resume an agent
// without hardcoding an agent id lives here.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

export type ParserKind = "claude_jsonl";

/** A registered adapter's id, as `list_agents` reports it.
 *
 *  An alias over `string` rather than a union of the ids that ship, because the
 *  registry is open: a user TOML in `~/.config/sway/agents/` adds an id Sway
 *  has never heard of, and this id is what selects that adapter's parser kind
 *  and pgrep pattern on the backend. A closed union here would compile fine and
 *  quietly probe every user adapter with claude's pattern. */
export type AgentId = string;

// A closed set, mirroring the Rust enum: a transport is a backend module
// implementing a wire protocol, so a TOML can only select one that exists.
export type ChatTransport = "claude_stream_json" | "acp";

// Something Sway knows about a model, keyed by the id the agent names it by.
//
export type ChatMode = {
  id: string;
  label: string;
  // One line on what this mode does, rendered on the menu row. Claude's are the
  // CLI's own wording rather than a paraphrase.
  hint: string;
  args: string[];
  // A per-model capability this mode needs, named as the live catalogue names
  // it (`supportsAutoMode`). Declared rather than keyed on the mode's id: the
  // gate is not a property of the word "auto".
  requires?: string | null;
  // This mode runs tools without asking anybody. A fact about the agent's
  // mode, unlike the retired `permissive_caveat` which was a fact about Sway's
  // gate, so it stays true now that the gate is gone.
  permissive?: boolean;
  // The mode a session runs when nothing is chosen, and what an unresolvable
  // one downgrades to. Declared rather than assumed: "default" is Claude's
  // spelling, and a resolver carrying it picks nothing on a agent that names
  // its modes otherwise.
  default?: boolean;
};

// A level `--effort` accepts that the agent's own catalogue never lists. Keyed
// by nothing, because an accepted flag value belongs to the binary rather than
// to one model. `measured_on` is what stops the claim outliving the
// measurement; see `dev/effort-probe.mjs`.
export type ChatEffortExtra = {
  id: string;
  label: string;
  state: "working" | "refused";
  measured_on: string;
  note?: string;
};

// Schema v2's `[chat]` table: how to drive this agent as a structured chat
// session instead of a PTY. Arg templates rather than hardcoded flags, so a
// second agent is a TOML table rather than a frontend branch.
export type ChatConfig = {
  transport: ChatTransport;
  // Defaults to `program` on the backend; the chat binary need not be the one
  // the PTY tab launches.
  program: string;
  base_args: string[];
  session_id_args: string[];
  resume_args: string[];
  model_args: string[];
  effort_args: string[];
  mode_args: string[];
  add_dir_args: string[];
  // Effort levels Sway measured that this agent never advertises. Empty for
  // every agent nobody has measured, which is all of them but claude.
  effort_extras: ChatEffortExtra[];
  // This agent's model names carry a "Provider/Name" path the picker may split
  // for display. Optional in the mirror (like fork_args) so a test literal
  // need not spell it; the backend always sends it.
  split_model_names?: boolean;
  modes: ChatMode[];
  // `[chat.acp]`: how this agent departs from a spec-correct ACP client. Present
  // and at its defaults for every transport, inert for the ones that are not ACP.
  acp: AcpOverrides;
};

// The two per-agent ACP quirks an adapter may declare. Two named fields rather
// than free-form JSON, so a third has to be argued for on the backend before a
// TOML can spell it.
export type AcpOverrides = {
  serve_client_fs: boolean;
};

// Mirrors `AccountsConfig` in src-tauri/src/agents.rs, schema v3's [accounts].
//
// `home_env` is the variable that points the agent at an isolated profile
// home; the *default* profile is that variable left unset, which is what makes
// it resolve the login the user already had. `supports_isolation` is a measured
// claim, never an inference from having a `home_env`: an adapter can have a
// home variable and still share one credential store behind it, in which case
// adding a second account would sign the first one out.
export type AccountsConfig = {
  home_env: string | null;
  login_args: string[];
  logout_args: string[];
  whoami_args: string[];
  // How to read what `whoami_args` prints. Null exactly when there are no args
  // to read. Three kinds because the three measured agents agree on nothing:
  // Claude answers in JSON, Codex says everything in its exit code, and
  // OpenCode exits 0 either way and puts the answer in a table.
  whoami_kind: "claude_json" | "exit_code" | "opencode_credentials" | null;
  supports_isolation: boolean;
};

export type Adapter = {
  id: string;
  label: string;
  /** The agent logo this adapter wears, as a key into `agentMarks.tsx`.
   *  Null for one that names none: every call site falls back rather than
   *  borrowing another agent's mark. */
  icon?: string | null;
  program: string;
  base_args: string[];
  yolo_args: string[];
  // `{id}`/`{file}` placeholder template; substitute via `applyTemplate`.
  resume_args: string[];
  // Null together for a protocol-backed adapter, whose sessions are not files:
  // there is no transcript format to parse and no command line naming a session
  // to match. See src-tauri/src/agents.rs's `AgentAdapter::discovery`.
  parser_kind: ParserKind | null;
  running_pattern: string | null;
  pty_quiet_ms: number;
  // Null for a PTY-only agent, which is the normal case rather than a
  // degraded one: a PTY-only adapter ships without a chat transport.
  chat?: ChatConfig | null;
  // Null for an adapter that declares no sign-in of its own. That is not
  // "signed out": it means Sway has nothing true to say about this adapter's
  // accounts, so it renders no account controls at all rather than an inert set.
  accounts?: AccountsConfig | null;
};

// Matches the bundled TOML (src-tauri/agents/*.toml) so
// the first paint - before `list_agents` resolves - looks identical to the
// pre-registry hardcoded behavior, and so a failed `invoke` degrades to that
// same shape.
//
// Hand-maintained, which is exactly how it goes stale, so agents.test.ts
// checks it against the resolved adapters the backend actually produces
// (dev/fixtures/agents/bundled.json, written by the Rust test) rather than
// against nothing.
export const FALLBACK_ADAPTERS: Adapter[] = [
  {
    id: "claude",
    label: "Claude",
    icon: "claude",
    program: "claude",
    base_args: [],
    yolo_args: ["--dangerously-skip-permissions"],
    resume_args: ["--resume", "{id}"],
    parser_kind: "claude_jsonl",
    // The token run matches a chat's command line too, where base_args come
    // before `--resume`/`--session-id`. See agents/claude.toml.
    running_pattern: "claude ([^ ]+ )*(--resume|-r|--session-id) {id}",
    pty_quiet_ms: 2000,
    // The chat table is deliberately omitted here rather than duplicated: the
    // fallback exists so the *sidebar* paints before `list_agents` resolves,
    // and nothing on that path reads models or arg templates. A chat session
    // is only ever started from a resolved adapter, so a stale copy of the
    // model list would be a liability with no upside. `chatCapable` treats an
    // unresolved agent as not-yet-chat-capable rather than guessing.
    chat: null,
    // Omitted for the same reason, and one more: an account list is per-user
    // state that the fallback cannot know. Nothing on the first-paint path
    // reads it, and guessing "no accounts" would render a sign-in prompt at a
    // user who is already signed in.
    accounts: null,
  },
  {
    id: "opencode",
    label: "OpenCode",
    icon: "opencode",
    program: "opencode",
    base_args: [],
    yolo_args: ["--auto"],
    // Empty: an ACP row's id is Sway's own, not one the agent minted, so a PTY
    // resume would start a fresh session while claiming to continue one. The UI
    // reads the empty template as "this agent's sessions can't be resumed".
    resume_args: [],
    // Null together, and this is the whole of what "protocol-backed" means at
    // first paint: no transcript to parse, and no command line naming a session.
    parser_kind: null,
    running_pattern: null,
    pty_quiet_ms: 2000,
    chat: null,
    accounts: null,
  },
  {
    id: "gemini",
    label: "Gemini",
    icon: "gemini",
    program: "gemini",
    base_args: [],
    yolo_args: ["--yolo"],
    resume_args: [],
    parser_kind: null,
    running_pattern: null,
    pty_quiet_ms: 2000,
    chat: null,
    accounts: null,
  },
  {
    id: "codex",
    label: "Codex",
    icon: "codex",
    program: "codex",
    base_args: [],
    yolo_args: ["--dangerously-bypass-approvals-and-sandbox"],
    resume_args: [],
    parser_kind: null,
    running_pattern: null,
    pty_quiet_ms: 2000,
    // Null like the rest, and here it also hides an adapter whose chat
    // binary is `npx`. Nothing on the first-paint path should learn that.
    chat: null,
    accounts: null,
  },
  {
    id: "copilot",
    label: "Copilot",
    icon: "copilot",
    program: "copilot",
    base_args: [],
    yolo_args: ["--allow-all-tools"],
    resume_args: [],
    parser_kind: null,
    running_pattern: null,
    pty_quiet_ms: 2000,
    chat: null,
    accounts: null,
  },
  {
    id: "kimi",
    label: "Kimi",
    icon: "kimi",
    program: "kimi",
    base_args: [],
    // Empty in the TOML too: unmeasured, so no button is offered.
    yolo_args: [],
    resume_args: [],
    parser_kind: null,
    running_pattern: null,
    pty_quiet_ms: 2000,
    chat: null,
    accounts: null,
  },
  {
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
    // Null like the rest; pi is the other adapter whose chat binary is `npx`
    // (the pi-acp bridge), which the first paint equally must not learn.
    chat: null,
    accounts: null,
  },
];

const [agents, setAgents] = createSignal<Adapter[]>(FALLBACK_ADAPTERS);
export { agents };

// The one in-flight load, kept so a caller who needs a *resolved* adapter (not
// the fallback that paints first) can wait for it rather than race it.
let loading: Promise<void> | null = null;
export function ensureAdaptersLoaded(): Promise<void> {
  if (!loading) {
    loading = invoke<Adapter[]>("list_agents")
      .then((list) => {
        setAgents(list.length ? list : FALLBACK_ADAPTERS);
      })
      .catch(() => {});
  }
  return loading;
}

export function findAdapter(id: string): Adapter {
  return agents().find((a) => a.id === id) ?? FALLBACK_ADAPTERS[0];
}

/** The adapter id behind a launch binary.
 *
 *  A terminal tab records what it spawned, which is a program name; every
 *  backend probe wants the adapter *id*, and the two are only the same word by
 *  convention. The chat binary is checked too, since an adapter may drive chat
 *  through a different executable than its PTY tab: `codex` is that case, whose
 *  chat runs `npx`. Which means a second adapter launched through the same
 *  package runner would be indistinguishable here and the first would win.
 *  Acceptable while `codex` is the only one, and the fix if that changes is to
 *  compare the package rather than the runner, as `catalog::launch_identity`
 *  already does. Falls back to the program itself, which is the id for every
 *  adapter that names them alike. */
export function agentIdForProgram(program: string): AgentId {
  const a = agents().find((x) => x.program === program || x.chat?.program === program);
  return a?.id ?? program;
}

// Whether this agent can be opened as a structured chat session rather than a
// PTY tab. False for a PTY-only adapter, and false for the pre-resolve
// fallback, so a chat surface is only ever offered once the real adapter has
// been read - never on a guess about what the backend will report.
export function chatCapable(agent: Adapter): boolean {
  return agent.chat != null;
}

// An adapter can express a mode or effort level two ways: the table-level
// template (`mode_args = ["--permission-mode", "{mode}"]`) or the entry's own
// `args`. Without a stated rule each consumer would pick one and they would
// disagree, so the rule is fixed and lives here: an entry's own args win when
// non-empty, otherwise the template is filled with the entry's id. Mirrors the
// backend's `ChatConfig::mode_args_for`/`effort_args_for`.
//
// Null for an id the adapter never declared, rather than a filled template for
// a mode that does not exist.
// split/join rather than `replaceAll`, which needs a newer `lib` target than
// this project sets, and rather than `.replace(str, ...)`, which would swap
// only the first occurrence where the backend's `str::replace` swaps them all.
function fillTemplate(template: string[], key: string, value: string): string[] {
  return template.map((a) => a.split(`{${key}}`).join(value));
}

export function modeArgsFor(chat: ChatConfig, modeId: string): string[] | null {
  const mode = chat.modes.find((m) => m.id === modeId);
  if (!mode) return null;
  return mode.args.length > 0 ? mode.args : fillTemplate(chat.mode_args, "mode", modeId);
}

// Effort joined the model side of that line: any level fills the template,
// because the levels come from the agent's catalogue and there is no declared
// list left for one to be unknown to. Null is an adapter with no template at
// all, whose levels are session options set after open rather than argv.
export function effortArgsFor(chat: ChatConfig, effortId: string): string[] | null {
  if (chat.effort_args.length === 0) return null;
  return fillTemplate(chat.effort_args, "effort", effortId);
}

// Unlike the two above, any id fills the template: there is no declared model
// list to be unknown to. The adapter says how to spell a model as args, the
// catalogue the id came from says which models exist. Mirrors the backend's
// `ChatConfig::model_args_for`.
export function modelArgsFor(chat: ChatConfig, modelId: string): string[] {
  return fillTemplate(chat.model_args, "model", modelId);
}

// Substitute `{id}`/`{file}` placeholders in an arg template (mirrors the
// backend's `agents::apply_template`).
export function applyTemplate(template: string[], vars: { id?: string; file?: string }): string[] {
  return template.map((a) => a.replace("{id}", vars.id ?? "").replace("{file}", vars.file ?? ""));
}

// Single-quote an argument for a POSIX shell. The copied resume command is
// pasted into a real shell, which re-parses it, so a session file path with a
// space (or any other metacharacter) has to survive that round trip. Embedded
// single quotes close and reopen the quoting the usual way.
const shQuote = (a: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

// The shell command that resumes a session outside Sway: the adapter's launch
// binary plus its resume template, filled and quoted. Null for a resume-less
// adapter (empty `resume_args`), whose sessions cannot be resumed at all.
export function resumeCommand(agent: Adapter, vars: { id: string; file: string }): string | null {
  if (agent.resume_args.length === 0) return null;
  return [agent.program, ...applyTemplate(agent.resume_args, vars)].map(shQuote).join(" ");
}

