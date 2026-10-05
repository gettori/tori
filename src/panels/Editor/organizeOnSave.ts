// What a save writes when the language server is asked to organize the imports
// first.
//
// The same race `formatOnSave.ts` is about, with a different thing on the other
// end of it: there the round trip is a subprocess, here it is a language server
// that may be busy indexing, and either way a fast typist puts characters into
// the buffer while it happens. Those characters are in no reply, so applying
// one afterwards deletes work the user just did, silently, as part of a save
// they asked for. `Text` is immutable, so the identity of `state.doc` is the
// available handle on "is this still the document I asked about?" - the same
// guard, deliberately spelled the same way.
//
// **And there is a second failure this one has that formatting does not.** A
// language server can simply not answer. `formatForSave` runs a subprocess that
// exits; this asks a server whose own timeout is 20 s for TypeScript and 90 s
// for rust-analyzer, and a ⌘S that hangs for ninety seconds is a broken editor.
// So the round trip is bounded here, on a timescale measured in a person's
// patience rather than a server's.
//
// Injected rather than reaching for the view, for `formatOnSave.ts`'s reason:
// every decision below is about somebody's unsaved keystrokes and none of them
// should need CodeMirror standing up to test.

import { ChangeSet, Text } from "@codemirror/state";
import type { Snapshot } from "./formatOnSave";
import type { LspTextEdit } from "./workspaceEdit";

/**
 * How long a save waits for the server.
 *
 * Deliberately **not** the session's `request_timeout_ms`, which is how long
 * Tori waits for a server at all and is sized for a cold rust-analyzer. This is
 * how long somebody waits for ⌘S, and it is also what a quit waits for: hot
 * exit saves every dirty buffer, so a hung server would otherwise hold the
 * window open one full server timeout per file.
 */
export const ORGANIZE_TIMEOUT_MS = 2000;

export type OrganizeDeps = {
  /** The organize-imports edits for this file, or null when there are none to
   *  have: no server, no such action, or an action that is a command rather
   *  than an edit (which cannot be applied to text on its way to disk). */
  organize: (path: string) => Promise<LspTextEdit[] | null>;
  /** That file's buffer as it is now, or null when it is no longer open at all.
   *  Called again after the server answers, which is the whole point. Takes the
   *  path rather than answering about whatever is on screen: a save can outlive
   *  the tab being on screen. */
  current: (path: string) => Snapshot | null;
  /** Bounded waiting, injected so a test can drive it on a fake clock. */
  delay?: (ms: number) => Promise<void>;
};

export type OrganizeText =
  /** Write this, and leave the buffer alone. */
  | { kind: "unchanged"; text: string }
  /** Put this into the buffer, then write it. */
  | { kind: "organized"; text: string }
  /** The file was closed mid-request; there is nothing to save. */
  | { kind: "gone" };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Decide what a save should write, asking the server to organize the imports
 * first.
 *
 * Never throws and never returns half a file: every refusal ends in the text
 * the caller already had, because the failure that matters here is a save that
 * writes something the user did not type.
 *
 * A server that is slow, broken, or has no opinion all end the same way, and
 * that is on purpose. None of them is worth a message: the user pressed ⌘S, and
 * what they need is the file on disk.
 */
export async function organizeForSave(deps: OrganizeDeps, path: string, before: Snapshot): Promise<OrganizeText> {
  const wait = deps.delay ?? sleep;
  let edits: LspTextEdit[] | null;
  try {
    edits = await Promise.race([
      deps.organize(path),
      // Resolves rather than rejects: losing this race is an ordinary outcome,
      // not an error, and the save carries on unorganized.
      wait(ORGANIZE_TIMEOUT_MS).then(() => null),
    ]);
  } catch (e) {
    console.error("organize imports failed", path, e);
    edits = null;
  }

  const now = deps.current(path);
  if (!now) return { kind: "gone" };

  // Typed into while the server was answering. Its edits describe a document
  // that no longer exists, so they are dropped and what is on screen is what
  // gets saved - including a same-length edit, which is why this compares
  // identity and not the text.
  if (now.id !== before.id) return { kind: "unchanged", text: now.text };
  if (!edits?.length) return { kind: "unchanged", text: before.text };

  const organized = applyEdits(before.text, edits);
  // A server that answered with edits amounting to nothing. Reported as
  // unchanged so the caller does not dispatch a no-op into the buffer and put
  // an empty step in its undo history.
  if (organized === null || organized === before.text) return { kind: "unchanged", text: before.text };
  return { kind: "organized", text: organized };
}

/** Apply LSP text edits to a string, or null when any of them cannot be placed.
 *
 *  Null rather than a partial result: an organize-imports applied to half its
 *  own edits is a file with a broken import block, which is worse than one that
 *  was left alone. */
function applyEdits(text: string, edits: LspTextEdit[]): string | null {
  const doc = Text.of(text.split("\n"));
  try {
    const changes = edits.map((e) => {
      const from = offsetOf(doc, e.range.start);
      const to = offsetOf(doc, e.range.end);
      if (from === null || to === null || to < from) throw new Error("edit outside the document");
      return { from, to, insert: e.newText };
    });
    return ChangeSet.of(changes, doc.length).apply(doc).toString();
  } catch (e) {
    console.error("could not place the organize-imports edits", e);
    return null;
  }
}

function offsetOf(doc: Text, pos: { line: number; character: number }): number | null {
  // A server counts lines from zero; `Text` counts from one. A position past
  // the end is a server answering about a document Tori no longer has, which is
  // the case this whole module's identity guard exists for - but the guard only
  // covers *local* edits, and a stale server answer can arrive for a file that
  // changed on disk too.
  if (pos.line < 0 || pos.line >= doc.lines) return null;
  const line = doc.line(pos.line + 1);
  // Clamped rather than refused: a character past the end of a line is how a
  // server spells "the end of this line" when its idea of the line is one
  // character longer, and refusing there would drop an otherwise fine edit.
  return line.from + Math.min(Math.max(pos.character, 0), line.length);
}
