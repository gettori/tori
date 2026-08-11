// Typing at the program.
//
// The console's other half: Phase 4 made it a place output arrives, this makes
// it a place you can answer. Both write into the same transcript on purpose,
// because the order is the point: what you asked and what the program printed
// while answering are only readable together.
//
// No Solid state of its own. A REPL entry is an event, not a value, so there is
// nothing to hold between one and the next beyond the transcript itself.

import { debugSession } from "./dapSessions";
import { currentFrame, leafSessions } from "./debugStack";
import { noteConsoleLine } from "./debugStore";

/** What the transcript calls the person typing, in the column a session name
 *  occupies for program output. */
const YOU = "you";

/**
 * What has been entered, oldest first.
 *
 * Module state rather than component state, because the pane unmounts every
 * time the right side changes mode and a REPL that forgets what you just typed
 * when you glance at the file tree is one you retype into. Capped for the
 * reason the transcript is.
 */
const MAX_HISTORY = 100;
const history: string[] = [];

/** Everything entered this session, oldest first. */
export function replHistory(): readonly string[] {
  return history;
}

function remember(expression: string): void {
  // A repeat of the line immediately above adds nothing to walk back through.
  if (history[history.length - 1] === expression) return;
  history.push(expression);
  if (history.length > MAX_HISTORY) history.shift();
}

/**
 * Evaluate one line in the debug console.
 *
 * Where it is evaluated depends on what there is: the selected frame when the
 * program is paused, and the running program otherwise (a leaf session, since
 * Phase 1 measured that the root never runs program code). With neither, it
 * says so on a line rather than doing nothing, which is the whole difference
 * between a REPL that is idle and one that is broken.
 */
export async function evaluateRepl(input: string): Promise<void> {
  const expression = input.trim();
  if (!expression) return;
  // Echoed first, and unconditionally: an entry that produced only an error
  // still has to show what was entered, or the error names nothing.
  remember(expression);
  noteConsoleLine(YOU, "repl", `> ${expression}`);

  const at = currentFrame();
  // The newest leaf rather than the first: a test runner's workers arrive in
  // spawn order, and the one you just watched print is the last of them.
  // (`.at(-1)` is ES2022 and this target is ES2020.)
  const leaves = leafSessions();
  const session = at ? debugSession(at.stop.id) : (leaves[leaves.length - 1] ?? null);
  if (!session) {
    noteConsoleLine(YOU, "repl", "No debug session. Start one with F5 to evaluate here.");
    return;
  }

  try {
    const body = await session.conn.request<{ result?: string }>("evaluate", {
      expression,
      // Only when paused. Sent as undefined otherwise, which is DAP's own way
      // of saying "the global scope" rather than a frame that does not exist.
      ...(at ? { frameId: at.frame.id } : {}),
      context: "repl",
    });
    // Never silent on success: an adapter that answers an empty string has
    // still answered, and a REPL that prints nothing reads as one that hung.
    noteConsoleLine(session.name, "repl", body?.result || "(no value)");
  } catch (e: unknown) {
    // The adapter's message, on a line: a REPL that swallows its own errors is
    // one where a typo and a null are the same answer.
    noteConsoleLine(session.name, "repl", e instanceof Error ? e.message : String(e));
  }
}
