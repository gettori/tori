// Mirrors src-tauri/src/agents.rs's `AgentAdapter` (the JSON `list_agents`
// returns). Backend-only fields (discovery dir, filename regex) aren't
// exposed; everything else the frontend needs to launch/resume an agent
// without hardcoding "claude"/"pi" lives here.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

export type ParserKind = "claude_jsonl" | "pi_jsonl" | "opencode_sqlite";

// A closed set, mirroring the Rust enum: a transport is a backend module
// implementing a wire protocol, so a TOML can only select one that exists.
export type ChatTransport = "claude_stream_json";

export type ChatModel = {
  id: string;
  label: string;
  // Null when the adapter declares no window; the context meter only renders
  // when one is declared rather than inventing a denominator.
  context_window: number | null;
  // Empty for a model with no effort control, which hides the picker rather
  // than rendering an inert one.
  effort_levels: string[];
  supports_thinking: boolean;
  supports_images: boolean;
};

export type ChatMode = {
  id: string;
  label: string;
  args: string[];
};

export type ChatEffort = {
  id: string;
  label: string;
  args: string[];
};

// Schema v2's `[chat]` table: how to drive this agent as a structured chat
// session instead of a PTY. Arg templates rather than hardcoded flags, so a
// second harness is a TOML table rather than a frontend branch.
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
  models: ChatModel[];
  modes: ChatMode[];
  effort: ChatEffort[];
};

export type Agent = {
  id: string;
  label: string;
  program: string;
  base_args: string[];
  yolo_args: string[];
  // `{id}`/`{file}` placeholder template; substitute via `applyTemplate`.
  resume_args: string[];
  parser_kind: ParserKind;
  running_pattern: string;
  pty_quiet_ms: number;
  // Null for a PTY-only agent, which is the normal case rather than a
  // degraded one: pi and opencode ship without a chat transport.
  chat?: ChatConfig | null;
};

// Matches the bundled claude/pi/opencode TOML (src-tauri/agents/*.toml) so
// the first paint - before `list_agents` resolves - looks identical to the
// pre-registry hardcoded behavior, and so a failed `invoke` degrades to that
// same shape.
//
// Hand-maintained, which is exactly how it goes stale, so agents.test.ts
// checks it against the resolved adapters the backend actually produces
// (dev/fixtures/agents/bundled.json, written by the Rust test) rather than
// against nothing.
export const FALLBACK_AGENTS: Agent[] = [
  {
    id: "claude",
    label: "Claude",
    program: "claude",
    base_args: [],
    yolo_args: ["--dangerously-skip-permissions"],
    resume_args: ["--resume", "{id}"],
    parser_kind: "claude_jsonl",
    running_pattern: "claude (--resume|-r) {id}",
    pty_quiet_ms: 2000,
    // The chat table is deliberately omitted here rather than duplicated: the
    // fallback exists so the *sidebar* paints before `list_agents` resolves,
    // and nothing on that path reads models or arg templates. A chat session
    // is only ever started from a resolved adapter, so a stale copy of the
    // model list would be a liability with no upside. `chatCapable` treats an
    // unresolved agent as not-yet-chat-capable rather than guessing.
    chat: null,
  },
  {
    id: "pi",
    label: "Pi",
    program: "pi",
    base_args: [],
    yolo_args: [],
    resume_args: ["--session", "{file}"],
    parser_kind: "pi_jsonl",
    running_pattern: "pi --session .*{id}",
    pty_quiet_ms: 2000,
    chat: null,
  },
  {
    id: "opencode",
    label: "opencode",
    program: "opencode",
    base_args: [],
    yolo_args: ["--auto"],
    resume_args: ["--session", "{id}"],
    parser_kind: "opencode_sqlite",
    running_pattern: "opencode.*--session {id}",
    pty_quiet_ms: 2000,
    chat: null,
  },
];

const [agents, setAgents] = createSignal<Agent[]>(FALLBACK_AGENTS);
export { agents };

let requested = false;
export function ensureAgentsLoaded() {
  if (requested) return;
  requested = true;
  invoke<Agent[]>("list_agents")
    .then((list) => setAgents(list.length ? list : FALLBACK_AGENTS))
    .catch(() => {});
}

export function findAgent(id: string): Agent {
  return agents().find((a) => a.id === id) ?? FALLBACK_AGENTS[0];
}

// Whether this agent can be opened as a structured chat session rather than a
// PTY tab. False for a PTY-only adapter, and false for the pre-resolve
// fallback, so a chat surface is only ever offered once the real adapter has
// been read - never on a guess about what the backend will report.
export function chatCapable(agent: Agent): boolean {
  return agent.chat != null;
}

// The effort levels a model actually supports, resolved against the adapter's
// `[[chat.effort]]` entries. Empty means the control is hidden rather than
// rendered inert. The backend rejects a model naming an undefined level, so a
// miss here means the adapter was not resolved, not that the TOML is bad.
export function effortLevelsFor(chat: ChatConfig, modelId: string): ChatEffort[] {
  const model = chat.models.find((m) => m.id === modelId);
  if (!model) return [];
  return model.effort_levels
    .map((id) => chat.effort.find((e) => e.id === id))
    .filter((e): e is ChatEffort => e != null);
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

export function effortArgsFor(chat: ChatConfig, effortId: string): string[] | null {
  const level = chat.effort.find((e) => e.id === effortId);
  if (!level) return null;
  return level.args.length > 0 ? level.args : fillTemplate(chat.effort_args, "effort", effortId);
}

export function modelArgsFor(chat: ChatConfig, modelId: string): string[] | null {
  if (!chat.models.some((m) => m.id === modelId)) return null;
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
export function resumeCommand(agent: Agent, vars: { id: string; file: string }): string | null {
  if (agent.resume_args.length === 0) return null;
  return [agent.program, ...applyTemplate(agent.resume_args, vars)].map(shQuote).join(" ");
}

