// A review is several comments and one send each costs a trip per hunk, so they
// wait here and go as one message. Memory only: a range goes stale once the
// agent edits, so a list kept across a relaunch would point at moved code.
import { createSignal } from "solid-js";

export type HeldComment = {
  id: string;
  /** Absolute, so a mention can be made relative to whichever session it goes to. */
  path: string;
  startLine: number;
  endLine: number;
  text: string;
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
