// Which renderer a tool call gets, and the one-line digest it collapses to.
//
// Pure and separate from the card, because "does an unknown tool still render"
// is the question worth testing and it needs no DOM to answer. An agent we do
// not control decides what it calls and how it answers - a plugin, an MCP
// server, a future release, a kind published after this build - so the fallback
// is the common case, not the error case.

import type { ChatItem, ToolItem } from "./chatStore";
import type { ToolKind, ToolSummary } from "../../utils/chatTypes";

/** The renderers a card can pick. `generic` is a JSON dump, and is correct for
 *  anything whose shape we have not been taught. */
export type ToolRenderer = "execute" | "read" | "edit" | "search" | "paths" | "fetch" | "generic";

/** The renderer a kind alone implies, for a call still running or one whose
 *  result no summariser recognised. Absent kinds fall through to `generic`. */
const BY_KIND: Partial<Record<ToolKind, ToolRenderer>> = {
  read: "read",
  edit: "edit",
  delete: "edit",
  move: "edit",
  search: "search",
  execute: "execute",
  fetch: "fetch",
};

/** The renderer the measured result implies. */
const BY_SUMMARY: Record<ToolSummary["type"], ToolRenderer> = {
  search: "search",
  paths: "paths",
  read: "read",
  execute: "execute",
  edit: "edit",
  fetch: "fetch",
};

/**
 * The body this call renders through.
 *
 * The tool's name is never consulted. The kind picks a shape as soon as the
 * call starts, and the summary refines it once the result lands, because only
 * the result can tell a hit list from a path list: Claude's `Grep` answers with
 * hits, with paths, or with a count depending on its `output_mode`, and `Glob`
 * answers with paths under the same `search` kind.
 */
export function toolRenderer(card: Pick<ToolItem, "toolKind" | "summary">): ToolRenderer {
  if (card.summary) return BY_SUMMARY[card.summary.type];
  return BY_KIND[card.toolKind] ?? "generic";
}

/** Does this call write files, and therefore have a diff worth fetching? */
export function isEditCall(card: Pick<ToolItem, "toolKind" | "summary">): boolean {
  return toolRenderer(card) === "edit";
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What the call did, in the few words a collapsed row has room for.
 *
 * Empty for a call with no summary, which is every running call and every
 * result whose shape no summariser recognised, so those rows read exactly as
 * they did before. The absent halves are the common case, not the edge: Claude
 * reports no exit code at all and no file count for a `Grep` in content mode.
 *
 * `read`'s `from` is deliberately not here. It says where the slice starts,
 * which is a body concern (the gutter opens at that line); the row only has
 * room for how much of the file was read.
 */
export function toolSummaryText(summary: ToolSummary | null): string {
  if (!summary) return "";
  switch (summary.type) {
    case "search": {
      const hits = plural(summary.hits, "hit");
      return summary.files === null ? hits : `${hits} in ${plural(summary.files, "file")}`;
    }
    case "paths":
      return plural(summary.count, "file");
    case "read":
      return summary.total === null
        ? plural(summary.lines, "line")
        : `${summary.lines} of ${plural(summary.total, "line")}`;
    case "execute": {
      const out = summary.lines === 0 ? "no output" : plural(summary.lines, "line");
      // A zero says nothing a settled row does not already say; a non-zero is
      // the whole point of showing the code.
      return summary.exitCode ? `exit ${summary.exitCode}, ${out}` : out;
    }
    case "edit":
      return `+${summary.added} -${summary.removed}`;
    case "fetch": {
      const parts: string[] = [];
      if (summary.status !== null) parts.push(String(summary.status));
      if (summary.bytes !== null) parts.push(bytes(summary.bytes));
      return parts.join(", ");
    }
  }
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
 *  file that does not exist. `locations` needs no such care: an agent that
 *  sends one has already said it is a path. */
export function toolPaths(card: Pick<ToolItem, "name" | "input" | "edits" | "files" | "locations">): string[] {
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
  for (const l of card.locations) add(l.path);
  for (const e of card.edits) add(e.path);
  for (const f of card.files) add(f);
  return found;
}

/**
 * Consecutive writes to one file, folded onto the first of them.
 *
 * An agent editing a file usually does it in three or four calls in a row, and
 * three cards saying `Edit MessageList.tsx` are three copies of one answer to
 * "what changed in this file". The rest of the transcript is untouched: only a
 * run of *adjacent* settled writes to the *same* path folds, so a read between
 * two edits ends the run, and a card still waiting on approval never folds into
 * anything, because approving is per call.
 *
 * `followers` maps the surviving card's id to what folded into it, in order.
 * `hidden` is every card that folded, which the list skips.
 */
export function foldEdits(items: ChatItem[]): { followers: Map<string, ToolItem[]>; hidden: Set<string> } {
  const followers = new Map<string, ToolItem[]>();
  const hidden = new Set<string>();
  let lead: ToolItem | null = null;

  const foldable = (it: ChatItem): it is ToolItem =>
    it.kind === "tool" && it.state === "ok" && it.approval === null && isEditCall(it) && toolPaths(it).length > 0;

  for (const item of items) {
    if (!foldable(item)) {
      lead = null;
      continue;
    }
    if (lead && toolPaths(lead)[0] === toolPaths(item)[0]) {
      followers.set(lead.id, [...(followers.get(lead.id) ?? []), item]);
      hidden.add(item.id);
      continue;
    }
    lead = item;
  }
  return { followers, hidden };
}

/** How long a call took, when it is long enough to be worth saying. */
export function formatDuration(ms: number | null): string {
  if (ms === null || ms < 1000) return "";
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`;
}
