// "Ask the agent about this frame" (#75).
//
// The last thing wave 8 adds, and the reason the rest of it is worth having in
// an editor that already sits next to an agent: a paused program knows exactly
// what went wrong, and until now that knowledge lived only on screen. This puts
// it in the prompt.
//
// Two surfaces offer it, the stack pane and the variables tree, and they must
// hand the agent the *same* sentence: it is the same question about the same
// pause, and two wordings drifting apart would read as two different requests.
// One composer and one send path here is what makes that true by construction
// rather than by two lists of words kept in step by hand
// ([[concept_safe_send]], and `conflictAsk.ts`'s shape).
//
// Everything it carries is bounded before it is composed, never after. A scope
// with five thousand names in it is a real thing js-debug will hand over, and a
// composer that pastes all of them costs the user their whole context window
// for one question. What is left out is *stated*, because a truncated list that
// says nothing is indistinguishable from a short one.
import { currentFrame, type StackFrame } from "./debugStack";
import { debugScopes, variableMore, variableRows, type VarRow } from "./debugVariables";
import { emitWith, TOAST, type ToastEvent } from "./events";
import { mentionPath } from "./pathScope";
import { requestSend, type SessionTarget } from "./safeSend";

/** How many frames the stack names before it stops listing them. Past this it
 *  is a paragraph of call sites nobody reads, and the frame that matters is at
 *  the top. */
export const FRAME_CAP = 8;

/** How many scopes are described. Locals and Closure are the two that say
 *  anything; Global is the third and is usually enormous. */
export const SCOPE_CAP = 3;

/** How many names per scope. */
export const VAR_CAP = 20;

/**
 * How long any one borrowed string may be.
 *
 * A serialized object is a paragraph on its own, and twenty of them would be
 * the whole message. It applies to names as much as to values: js-debug names a
 * frame `function Module(id = '', parent) {.executeUserEntryPoint`, so a frame
 * name is arbitrary source text too, and a cap that covers only the values is
 * not a cap.
 */
export const TEXT_CAP = 60;

/** One scope as the composer needs it. `more` is what the tree knows it has not
 *  fetched, which is invisible in `rows` and must not be silently dropped. */
export type AskScope = { name: string; rows: readonly VarRow[]; more?: number };

/** One line, whatever the debuggee's `toString` did. `sanitizeOutput` already
 *  removed the control bytes and kept the newlines, and a raw newline submits
 *  the prompt on some agents, which would break the insert-only contract
 *  safe-send exists to keep. */
function flat(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function clip(value: string): string {
  const one = flat(value);
  return one.length > TEXT_CAP ? `${one.slice(0, TEXT_CAP)}…` : one;
}

/** Where the frame is, as something the agent can open. Path relativity follows
 *  the drag-mention convention (`mentionPath`): inside the target's cwd,
 *  relative; outside it, absolute. A frame with no path is code with no file
 *  behind it (a bundled dependency, an eval), so it is named rather than
 *  mentioned: an `@` on something no tool can read is a broken promise. */
function where(target: SessionTarget, frame: StackFrame): string {
  if (!frame.path) return `${clip(frame.sourceName)}:${frame.line}`;
  const cwd = target.sessionCwd || target.folderPath;
  return `@${mentionPath(frame.path, cwd)}#L${frame.line}`;
}

/**
 * The wire format for "here is where the program is stopped".
 *
 * The session is named first because a run is many sessions: Phase 1 measured
 * 214 of them for `pnpm test`, and "which one" is the first thing to know about
 * a frame. Then the reason, which is what separates a breakpoint from a thrown
 * exception, then where, then the way in, then what is in scope there.
 */
export function composeFrame(
  target: SessionTarget,
  stop: { name: string; reason: string },
  frame: StackFrame,
  stack: readonly StackFrame[],
  scopes: readonly AskScope[],
): string {
  // Every borrowed string goes through `clip`: the session name, the reason,
  // the frame names and the values are all somebody else's text, and any one of
  // them left whole is a cap that does not cap.
  const parts = [
    `${clip(stop.name)} is paused on ${clip(stop.reason)} in ${clip(frame.name)} at ${where(target, frame)}.`,
  ];

  // Only when there is a way in worth describing: a one-frame stack would
  // repeat the sentence above it in a different shape.
  if (stack.length > 1) {
    const listed = stack.slice(0, FRAME_CAP).map((f) => `${clip(f.name)} (${clip(f.sourceName)}:${f.line})`);
    const rest = stack.length - listed.length;
    const more = rest ? ` < ${rest} more frame${rest === 1 ? "" : "s"}` : "";
    parts.push(`Stack: ${listed.join(" < ")}${more}.`);
  }

  // An unexpanded scope has no rows, because the tree fetches on expand. That
  // is worth saying: a message with no variables in it reads as a frame that
  // had none, which is never true.
  const filled = scopes.filter((s) => s.rows.length > 0);
  if (!filled.length) {
    parts.push("No scope is expanded, so no variables are included.");
    return parts.join(" ");
  }
  for (const scope of filled.slice(0, SCOPE_CAP)) {
    const listed = scope.rows.slice(0, VAR_CAP).map((r) => `${clip(r.name)} = ${clip(r.value)}`);
    // What was cut here, plus what the tree never fetched. A paged container
    // holds one page of a thousand elements, and counting only the rows in hand
    // would report 80 missing out of 980.
    const rest = scope.rows.length - listed.length + (scope.more ?? 0);
    parts.push(`${clip(scope.name)}: ${listed.join(", ")}${rest ? `, and ${rest} more` : ""}.`);
  }
  const restScopes = filled.length - Math.min(filled.length, SCOPE_CAP);
  if (restScopes) parts.push(`And ${restScopes} more scope${restScopes === 1 ? "" : "s"} not included.`);
  return parts.join(" ");
}

/**
 * The composed ask for whatever is selected right now, or null when nothing is
 * paused.
 *
 * Reads the frame and the scopes here rather than taking them as arguments, so
 * every entry point composes exactly the same text: the stack pane and the
 * variables tree are two buttons on one question.
 */
export function frameAsk(target: SessionTarget): string | null {
  const at = currentFrame();
  if (!at) return null;
  const scopes = debugScopes().map((s) => ({
    name: s.name,
    rows: variableRows(s.key),
    more: variableMore(s.key),
  }));
  return composeFrame(target, at.stop, at.frame, at.stop.frames, scopes);
}

/**
 * Compose the ask and route it through safe-send.
 *
 * Only the timeout is reported here. Terminal.tsx already toasts a blocked
 * target with the shared wording; this one is the case where no Terminal
 * answered at all, which nothing else would mention.
 */
export async function askAgentAboutFrame(target: SessionTarget): Promise<void> {
  const text = frameAsk(target);
  if (!text) {
    emitWith<ToastEvent>(TOAST, { message: "Nothing is paused, so there is no frame to send.", kind: "error" });
    return;
  }
  const result = await requestSend({ ...target, text });
  if (result.kind === "timeout") {
    emitWith<ToastEvent>(TOAST, { message: "Couldn't reach the session, try again.", kind: "error" });
  }
}
