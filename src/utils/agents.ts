// Mirrors src-tauri/src/agents.rs's `AgentAdapter` (the JSON `list_agents`
// returns). Backend-only fields (discovery dir, filename regex) aren't
// exposed; everything else the frontend needs to launch/resume an agent
// without hardcoding "claude"/"pi" lives here.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

export type ParserKind = "claude_jsonl" | "pi_jsonl" | "opencode_sqlite";

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
  // Sidebar context meter (Phase 3): either one number for every model, or a
  // per-model table with a reserved "default" fallback key. Undefined when
  // the adapter declares no window - see ADAPTERS.md.
  context_window?: number | Record<string, number>;
};

// Matches the bundled claude/pi/opencode TOML (src-tauri/agents/*.toml) so
// the first paint - before `list_agents` resolves - looks identical to the
// pre-registry hardcoded behavior, and so a failed `invoke` degrades to that
// same shape.
const FALLBACK_AGENTS: Agent[] = [
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

// Substitute `{id}`/`{file}` placeholders in an arg template (mirrors the
// backend's `agents::apply_template`).
export function applyTemplate(template: string[], vars: { id?: string; file?: string }): string[] {
  return template.map((a) => a.replace("{id}", vars.id ?? "").replace("{file}", vars.file ?? ""));
}

// Resolve an agent's declared context window for a session's model (mirrors
// the backend's `ContextWindow::resolve`): a plain number applies to every
// model; a per-model table falls back to its "default" key. Null when the
// adapter declares no window at all - the meter must not render then.
export function resolveContextWindow(agent: Agent, model: string | null): number | null {
  const cw = agent.context_window;
  if (cw === undefined) return null;
  if (typeof cw === "number") return cw;
  if (model && cw[model] !== undefined) return cw[model];
  return cw["default"] ?? null;
}
