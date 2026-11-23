import { createSignal } from "solid-js";

/** A file to open once the editor is showing the worktree it lives in. Held
 *  rather than emitted, because a link into another worktree moves the
 *  selection first, and an open sent before the editor re-roots would land in
 *  the worktree just left. */
export type PendingFileOpen = { path: string; line?: number; at: number };

/** Past this the selection went somewhere else, and opening the file then would
 *  answer a click nobody remembers making. */
export const PENDING_OPEN_TTL_MS = 10_000;

const [pendingFileOpen, setPendingFileOpen] = createSignal<PendingFileOpen | null>(null);
export { pendingFileOpen, setPendingFileOpen };
