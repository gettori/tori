// The live "editing now" indicator: which file the selected session is writing
// *right now*, as opposed to touchedFiles' "wrote at some point this run".
//
// The hard rule is that a filename is never guessed. Two signals feed it, and
// they carry very different certainty:
//
//   - the *parser* path, from `session_editing_now`, which reads the file name
//     straight out of the transcript's last write tool_use. This is direct
//     attribution: the session itself said it wrote that file, so it stands
//     regardless of who else is active in the folder.
//   - the *fs* path, from `fs://changed`. The watcher says a file changed, not
//     who changed it. Attributing it to the selected session is only sound when
//     that session is the folder's sole live actor; with a second agent running
//     there, the same event is equally explicable by the other one.
//
// So the fs signal degrades rather than lies: sole actor gives a filename,
// anything else gives a file-less "editing…" pulse. Showing the wrong filename
// is worse than showing no filename, because the user acts on it.
import { createSignal } from "solid-js";
import { revertBlockers, type RevertCandidate } from "./revertGuard";

export type EditingIndication = { kind: "file"; path: string } | { kind: "anonymous" } | null;

/** Is the selected session the only thing that could be writing in this folder?
 *  Reuses the revert guard's blast-radius set, so "actor" means exactly what it
 *  means there: a live-tab session mid-turn, or a detached one whose activity
 *  Sway cannot verify. Anything else in the folder is idle and cannot be the
 *  author of an fs event.
 *
 *  `null` means the actor set is not known yet - the probe is in flight, or it
 *  failed. That is deliberately NOT the same as an empty set: an unknown folder
 *  is exactly the situation where naming a file would be a guess, so unknown
 *  answers false and the indicator falls back to the anonymous pulse. */
export function isSoleLiveActor(
  candidates: readonly RevertCandidate[] | null,
  selfSessionId: string | undefined,
  folderPath: string,
): boolean {
  if (candidates === null) return false;
  const others = candidates.filter((c) => c.sessionId !== selfSessionId);
  return revertBlockers(others, folderPath).length === 0;
}

/** Pure: compose the indicator from the two signals. `parserPath` is direct
 *  attribution and always wins; `fsPath` is circumstantial and is only named
 *  when nothing else in the folder could have written it. */
export function editingIndication(input: {
  /** The selected session's composed status is "executing". Nothing shows
   *  otherwise: the indicator answers "what is it editing", and a session that
   *  is not running a turn is not editing anything. */
  executing: boolean;
  parserPath?: string | null;
  fsPath?: string | null;
  soleLiveActor: boolean;
}): EditingIndication {
  if (!input.executing) return null;
  if (input.parserPath) return { kind: "file", path: input.parserPath };
  if (!input.fsPath) return null;
  return input.soleLiveActor ? { kind: "file", path: input.fsPath } : { kind: "anonymous" };
}

// How long an indication survives without a fresh signal. Long enough to ride
// out the gap between two tool calls in one burst, short enough that a turn
// that ends without a `sessions://changed` (or a watcher that misses the last
// write) does not leave a file pulsing indefinitely.
export const EDITING_QUIET_MS = 4000;

const [editingNow, setEditingNowSignal] = createSignal<EditingIndication>(null);
export { editingNow };

/// Called by Editor, the sole owner of the signals this composes from (it
/// already holds the touched fetch and the `fs://changed` listener).
export function setEditingNow(indication: EditingIndication) {
  setEditingNowSignal(indication);
}

/** True if the selected session is writing exactly `path` right now. False for
 *  the anonymous pulse, which by definition names no file. */
export function isEditingNow(path: string): boolean {
  const e = editingNow();
  return e?.kind === "file" && e.path === path;
}
