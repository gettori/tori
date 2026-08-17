// Which renderer a tool call gets, and the one-line digest it collapses to.
//
// Pure and separate from the card, because "does an unknown tool still render"
// is the question worth testing and it needs no DOM to answer. A agent we do
// not control decides what tool names exist - a plugin, an MCP server, a future
// Claude release - so the fallback is the common case, not the error case.

import type { ToolItem } from "./chatStore";

/** The renderers a card can pick. `generic` is a JSON dump, and is correct for
 *  anything whose shape we have not been taught. */
export type ToolRenderer = "bash" | "search" | "edit" | "web" | "task" | "generic";

/** Tools whose shape we render specially. Anything absent falls through to
 *  `generic` rather than being special-cased into a wrong renderer. */
const RENDERERS: Record<string, ToolRenderer> = {
  Bash: "bash",
  BashOutput: "bash",
  KillShell: "bash",
  Read: "search",
  Glob: "search",
  Grep: "search",
  NotebookEdit: "edit",
  Edit: "edit",
  Write: "edit",
  MultiEdit: "edit",
  WebFetch: "web",
  WebSearch: "web",
  Task: "task",
};

export function toolRenderer(name: string | null): ToolRenderer {
  if (!name) return "generic";
  return RENDERERS[name] ?? "generic";
}

/** Does this call write files, and therefore have a diff worth fetching? */
export function isEditTool(name: string | null): boolean {
  return toolRenderer(name) === "edit";
}

/** The argument that distinguishes one call of a tool from another, for the
 *  collapsed row. Empty when nothing identifies it, which renders as just the
 *  tool name rather than as a broken row. */
export function toolDigest(card: Pick<ToolItem, "name" | "input">): string {
  const input = card.input;
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  // Ordered by how much each identifies the call, not alphabetically: a Bash
  // call is its command, a Task is its description.
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    const v = rec[key];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/** Every file path a call refers to, for the clickable-path affordance.
 *
 *  Deliberately only the keys that are definitely paths. Guessing from a
 *  value's shape would turn a Grep pattern like `src/.*\.ts` into a link to a
 *  file that does not exist. */
export function toolPaths(card: Pick<ToolItem, "name" | "input" | "edits" | "files">): string[] {
  const found: string[] = [];
  const add = (p: unknown) => {
    if (typeof p === "string" && p && !found.includes(p)) found.push(p);
  };
  const input = card.input;
  if (input && typeof input === "object") {
    const rec = input as Record<string, unknown>;
    add(rec.file_path);
    add(rec.path);
    add(rec.notebook_path);
  }
  for (const e of card.edits) add(e.path);
  for (const f of card.files) add(f);
  return found;
}

/** How long a call took, when it is long enough to be worth saying. */
export function formatDuration(ms: number | null): string {
  if (ms === null || ms < 1000) return "";
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`;
}
