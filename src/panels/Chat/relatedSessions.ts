import { createEffect, createMemo, createResource, onCleanup, type Accessor } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ContentBlock } from "../../utils/chatTypes";
import { findSession, trackFolders } from "../../utils/sessionStore";
import { sessionDot, unitAt } from "../../utils/sessionActivity";
import { toriCall } from "./toriTool";
import type { SessionMeta } from "../../utils/sessionStore";
import type { SessionDot } from "../../utils/sessionStatus";
import { toriNote } from "../../utils/toriNote";
import type { ChatItem } from "./chatStore";
import type { RelatedSession, RelatedState, Relation, Side } from "./SessionChips";

/** One row of `session_relations`, mirroring `Related` in src-tauri/src/rpc/relations.rs plus its folder. */
export type RelationRow = { id: string; side: Side; relation: Relation; cwd: string | null };

// A prompt another session sent arrives wrapped as a Tori note, so the agent
// knows it is a peer's.
export function peerPrompt(blocks: readonly ContentBlock[]): { from: string; blocks: ContentBlock[] } | null {
  const note = toriNote([...blocks]);
  if (!note?.from || (note.kind !== "steer" && note.kind !== "linked")) return null;
  return { from: note.from, blocks: [{ type: "text", text: note.body }] };
}

export function incomingSenders(items: readonly ChatItem[]): string[] {
  const from = items.flatMap((i) => (i.kind === "user" ? (peerPrompt(i.blocks)?.from ?? []) : []));
  return [...new Set(from)];
}

const STATE: Record<SessionDot, RelatedState> = {
  working: "working",
  needsYou: "needsYou",
  solid: "idle",
  hollow: "idle",
  none: "done",
};

const lastSegment = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;

export type Lookups = {
  session: (id: string) => SessionMeta | undefined;
  dot: (id: string) => SessionDot;
  unit: (folder: string) => { projectPath: string; branch: string | null } | null;
};

export function mergeRelated(
  rows: readonly RelationRow[],
  senders: readonly string[],
  look: Lookups,
): RelatedSession[] {
  const prompted: RelationRow[] = senders
    .filter((id) => !rows.some((r) => r.id === id))
    .map((id) => ({ id, side: "from", relation: "prompted", cwd: look.session(id)?.cwd ?? null }));
  return [...rows, ...prompted].map((r) => {
    const meta = look.session(r.id);
    const folder = r.cwd ?? meta?.cwd ?? null;
    const unit = folder ? look.unit(folder) : null;
    return {
      id: r.id,
      name: meta?.name || meta?.title || "another session",
      side: r.side,
      relation: r.relation,
      state: STATE[look.dot(r.id)],
      project: unit ? lastSegment(unit.projectPath) : folder ? lastSegment(folder) : null,
      branch: unit?.branch ?? meta?.branch ?? null,
      lastAt: meta?.last_active ?? 0,
    };
  });
}

export function relatedFolders(rows: readonly RelationRow[]): string[] {
  return [...new Set(rows.flatMap((r) => (r.cwd ? [r.cwd] : [])))];
}

const LIVE: Lookups = { session: (id) => findSession(id)?.session, dot: sessionDot, unit: unitAt };

// Only these of a chat's own calls can change who it is tied to; refetching
// on every finished tool call would re-read the transcript after each edit.
const TIES = new Set(["session_spawn", "worktree_new", "session_steer"]);

export function createRelatedSessions(
  session: Accessor<string>,
  items: Accessor<readonly ChatItem[]>,
  look: Lookups = LIVE,
): Accessor<RelatedSession[]> {
  const ties = createMemo(
    () => items().filter((i) => i.kind === "tool" && i.state === "ok" && TIES.has(toriCall(i)?.tool ?? "")).length,
  );
  const [rows, { refetch }] = createResource(
    () => [session(), ties()] as const,
    ([id]) => invoke<RelationRow[]>("session_relations", { session: id }).catch(() => [] as RelationRow[]),
  );
  for (const event of ["links://changed", "config://changed"]) {
    const unlisten = listen(event, () => void refetch());
    onCleanup(() => void unlisten.then((stop) => stop()));
  }
  createEffect(() => void trackFolders(relatedFolders(rows() ?? [])));
  return createMemo(() => mergeRelated(rows() ?? [], incomingSenders(items()), look));
}
