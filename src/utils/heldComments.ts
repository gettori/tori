// A review is several comments and one send each costs a trip per hunk, so they
// wait here and go as one message. Memory only: a range goes stale once the agent
// edits. A reviewer's live in Rust, which checks staleness per file.
import { createSignal } from "solid-js";
import type { SessionTarget } from "./safeSend";

export type HeldComment = {
  id: string;
  /** Absolute, so a mention can be made relative to whichever session it goes to. */
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  /** The agent that gave a second opinion; absent on the user's own comments. */
  author?: string;
  /** The session a reviewer's comment is about. */
  session?: string;
  /** Where a reviewer's comment goes, whichever session is selected. */
  target?: SessionTarget;
  /** Why a reviewer's comment cannot be sent, when it cannot. */
  blocked?: string;
  /** The file changed since the reviewer read it. */
  stale?: boolean;
};

const [held, setHeld] = createSignal<Record<string, readonly HeldComment[]>>({});
let nextId = 0;

export function heldFor(key: string): readonly HeldComment[] {
  return held()[key] ?? [];
}

export function holdComment(key: string, comment: Omit<HeldComment, "id">): HeldComment {
  const entry = { ...comment, id: `held-${++nextId}` };
  setHeld((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), entry] }));
  return entry;
}

/** Replaces the reviewers' comments for `key` with `reviewed`, keeping the
 *  user's own as they are. Ids are the findings' own, so a reload never doubles one. */
export function syncReviewed(key: string, reviewed: readonly HeldComment[]) {
  setHeld((prev) => {
    const kept = [...(prev[key] ?? []).filter((c) => !c.author), ...reviewed];
    const next = { ...prev };
    if (kept.length) next[key] = kept;
    else delete next[key];
    return next;
  });
}

/** Drops the named entries and keeps the rest, so a comment held while a send
 *  was in flight survives that send clearing what it carried. */
export function dropHeld(key: string, ids: readonly string[]) {
  const gone = new Set(ids);
  setHeld((prev) => {
    const left = (prev[key] ?? []).filter((c) => !gone.has(c.id));
    const next = { ...prev };
    if (left.length) next[key] = left;
    else delete next[key];
    return next;
  });
}

export function clearHeld(key: string) {
  dropHeld(
    key,
    heldFor(key).map((c) => c.id),
  );
}
