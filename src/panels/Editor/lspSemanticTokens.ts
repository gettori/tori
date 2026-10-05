// Asking a running language server what the identifiers in a file actually are.
//
// Same split as `lspSymbols.ts` and for the same reason: the wire format, the
// legend and the decoder are CodeMirror-free in `utils/semanticTokens.ts`, and
// only the part that needs a live session is here.
//
// The legend is the wrinkle this file has and the symbol one does not. A
// `documentSymbol` reply is self-describing; a semantic-tokens reply is a list
// of integers that means nothing without the `legend` the server declared once,
// at `initialize`. So every request reads the legend off that session's
// capabilities first, and a session that has none is a session whose numbers
// cannot be interpreted - which is the same outcome as having no provider.

import { decodeSemanticTokens, legendFrom, type SemanticToken } from "../../utils/semanticTokens";
import { lspTargetFor } from "./lspClient";
import { pathToUri } from "./toriWorkspace";

/**
 * This file's semantic tokens, or null when there are none to have.
 *
 * Null covers every reason a file might not get them - no server, no provider,
 * no legend, a refusal, a timeout - because they are the same thing to the
 * caller: this file keeps the colours its grammar gave it, which is what every
 * file in Tori had before this existed.
 */
export async function requestSemanticTokens(path: string): Promise<SemanticToken[] | null> {
  const target = lspTargetFor(path);
  if (!target) return null;
  // A file opened as its server was starting arrives here before `initialize`
  // has been answered, and the legend does not exist until it has.
  await target.ready;
  const legend = legendFrom(target.capability("semanticTokensProvider"));
  if (!legend) return null;
  // Every token is a position, so the server has to be looking at the document
  // those positions are in. The library's own sync is debounced by 500 ms, and
  // colouring a file against the document as it was two keystrokes ago puts the
  // colours a few characters to the left of the words they belong to.
  target.sync();
  try {
    const res = await target.request<{ data?: unknown } | null>("textDocument/semanticTokens/full", {
      textDocument: { uri: pathToUri(path) },
    });
    // A server is allowed to answer null, meaning "nothing to say about this
    // file". Distinct from a refusal only in that it is not worth logging.
    if (!res) return [];
    return decodeSemanticTokens(res.data, legend);
  } catch (e) {
    console.error("semanticTokens/full failed", path, e);
    return null;
  }
}

// One token per path with a request outstanding, the same guard
// `refreshDocumentSymbols` carries and for the same reason.
const pending = new Map<string, number>();

/** The buffer an answer might be applied to, at one moment. `id` is
 *  `state.doc`, held only to be compared by identity - nothing here reads it -
 *  and `painted` is how many semantic decorations it is already carrying. */
export type Painted = { id: unknown; painted: number };

/** Injected rather than reached for, the same shape `lspRename` and
 *  `formatOnSave` use, and for the same reason: every branch below is about a
 *  race between a subprocess and somebody typing, and none of them should need
 *  CodeMirror standing up to test. */
export type SemanticDeps = {
  /** `path`'s buffer as it is now, or null when this answer has nowhere to go.
   *  Called again after the server replies, which is the whole point.
   *
   *  Null covers "not on screen any more" as well as "closed": unlike a save,
   *  there is nothing owed to a background buffer, because nobody is looking at
   *  its colours and it re-asks the moment it comes back. */
  current: (path: string) => Painted | null;
  paint: (path: string, tokens: SemanticToken[]) => void;
  /** Ask again later. Called when the document moved while the server was
   *  answering, which is the only outcome here that has to converge on its own. */
  again: (path: string) => void;
};

export type PaintOutcome =
  /** Applied. */
  | "painted"
  /** Nothing to paint and nothing already painted: a plain text file, or a
   *  second empty answer. Distinguished so a swap does not dispatch an empty
   *  effect into every buffer that will never have colours. */
  | "unchanged"
  /** Typed into while the server answered. Every token in the reply is a
   *  position in a document that no longer exists, so it is dropped and `again`
   *  is called. */
  | "moved"
  /** A newer ask for this same path has already been made. */
  | "superseded"
  /** The buffer is not there to paint. */
  | "gone";

/**
 * Ask for `path`'s tokens and paint them, unless something happened meanwhile.
 *
 * Four things re-ask: a tab swap, a client coming up, the typing debounce, and
 * the server's own `workspace/semanticTokens/refresh`. A busy server can answer
 * them out of order, and an older reply landing last is not a stale outline the
 * user can ignore - it is every colour in the file placed against a document
 * that has since been edited.
 *
 * `paint` is given `[]` rather than nothing when the answer is null, so a file
 * that loses its server is cleared rather than left wearing a dead one's
 * colours.
 */
export async function refreshSemanticTokens(deps: SemanticDeps, path: string): Promise<PaintOutcome> {
  const before = deps.current(path);
  if (!before) return "gone";
  const token = (pending.get(path) ?? 0) + 1;
  pending.set(path, token);
  const tokens = await requestSemanticTokens(path);
  if (pending.get(path) !== token) return "superseded";
  pending.delete(path);
  const now = deps.current(path);
  if (!now) return "gone";
  if (now.id !== before.id) {
    // Through the caller's debounce rather than immediately: that is what keeps
    // a fast typist from turning every keystroke into a round trip, since the
    // re-asks coalesce into one.
    deps.again(path);
    return "moved";
  }
  const list = tokens ?? [];
  if (!list.length && now.painted === 0) return "unchanged";
  deps.paint(path, list);
  return "painted";
}
