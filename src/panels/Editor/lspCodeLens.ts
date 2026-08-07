// Asking a running server what is worth saying *above* a line.
//
// A code lens is the one language feature that is not an answer to a question
// the user asked: nobody puts the caret anywhere to get "3 references". So it is
// the one feature that costs a request per file per edit whether or not anybody
// reads it, which is the whole reason it ships behind a setting that defaults to
// off (#68).
//
// Two requests, and the second is the expensive one. `textDocument/codeLens`
// answers *where* the lenses go, cheaply, because a server can decide that from
// the syntax tree alone; a lens with no `command` then needs `codeLens/resolve`
// to find out what it says, which is where the reference counting actually
// happens. Both tsserver and rust-analyzer answer that way, so a file with fifty
// functions is fifty resolves. `MAX_CODE_LENSES` is what keeps that bounded.
//
// The CM6 half is `codeLensWidget.ts`; nothing here touches a view, so every
// decision below is testable without one, the split `lspSemanticTokens.ts` uses.

import { lspTargetFor, type LspTarget } from "./lspClient";
import { pathToUri } from "./swayWorkspace";

/**
 * The capability block.
 *
 * `codeLens: {}` on the document side, empty for `callHierarchy`'s reason: the
 * spec's only field there is the `dynamicRegistration` this client must not
 * advertise, since it answers server-initiated registration with `-32601`.
 *
 * `workspace.codeLens.refreshSupport` is the half that is *not* empty, and it
 * is a promise rather than a preference: it tells the server it may push
 * `workspace/codeLens/refresh` instead of leaving Sway to guess when its counts
 * went stale. Declaring it without answering it is worse than not declaring it,
 * so the router entry in `lspClient.ts` is part of this block, not a follow-up.
 */
export const codeLensClientCapabilities = {
  clientCapabilities: {
    textDocument: {
      codeLens: {},
    },
    workspace: {
      codeLens: { refreshSupport: true },
    },
  },
};

/**
 * Most lenses one file may contribute.
 *
 * Bounded because the resolve is per lens: a generated file with thousands of
 * exported symbols is thousands of round trips, issued together, for labels
 * nobody scrolled to. A hundred is more than fits on a screen several times
 * over, so the cap is invisible in every file a person is actually reading.
 */
export const MAX_CODE_LENSES = 100;

/** One lens, placed and (once resolved) labelled. */
export type CodeLensItem = {
  /** 1-based, as CodeMirror counts lines. */
  line: number;
  /** What the lens says. Null between the two requests, and dropped rather
   *  than drawn if it is still null afterwards: a lens with no title is a
   *  blank strip of vertical space where a line used to be. */
  title: string | null;
  /** The server's own lens object, kept verbatim because `codeLens/resolve`
   *  is handed it back. The spec's round trip is "the lens you gave me", and a
   *  server hangs its own `data` on it: a rebuilt lens resolves to nothing,
   *  with nothing on the wire to say why. */
  raw: unknown;
};

function lensOf(raw: unknown): CodeLensItem | null {
  const lens = raw as { range?: { start?: { line?: unknown } }; command?: { title?: unknown } } | null;
  const line = lens?.range?.start?.line;
  if (typeof line !== "number") return null;
  const title = lens?.command?.title;
  return {
    // LSP counts lines from 0 and CodeMirror from 1.
    line: line + 1,
    title: typeof title === "string" ? title : null,
    raw,
  };
}

/** What `textDocument/codeLens` answered, as items. */
export function normalizeCodeLenses(res: unknown): CodeLensItem[] {
  if (!Array.isArray(res)) return [];
  return res
    .slice(0, MAX_CODE_LENSES)
    .map(lensOf)
    .filter((l): l is CodeLensItem => l !== null);
}

/**
 * Fill in the lenses that arrived without a title.
 *
 * Skipped entirely unless the server advertised `resolveProvider`:
 * `codeLensProvider: {}` says "I place lenses", not "I can resolve them", and
 * asking anyway draws a `MethodNotFound` per lens.
 *
 * A resolve that fails leaves its lens untitled rather than taking the others
 * with it, and the untitled ones are dropped by the caller. One server refusing
 * one lens should cost that lens, not the file's.
 */
async function resolveTitles(target: LspTarget, lenses: CodeLensItem[]): Promise<CodeLensItem[]> {
  if (!target.capability("codeLensProvider")?.resolveProvider) return lenses;
  return Promise.all(
    lenses.map(async (lens) => {
      if (lens.title !== null) return lens;
      try {
        const res = await target.request<unknown>("codeLens/resolve", lens.raw);
        return { ...lens, title: lensOf(res)?.title ?? null };
      } catch (e) {
        console.warn("codeLens/resolve failed", e);
        return lens;
      }
    }),
  );
}

/**
 * This file's lenses, or null when there are none to have.
 *
 * Null covers every reason a file might not get them (no server, no provider, a
 * refusal, a timeout) because they are the same thing to the caller: the file
 * renders exactly as it did before this feature existed. The caller still
 * paints, with an empty list, so a file that loses its server loses its lenses
 * rather than keeping a dead one's counts.
 */
export async function requestCodeLenses(path: string): Promise<CodeLensItem[] | null> {
  const target = lspTargetFor(path);
  if (!target) return null;
  // A file opened as its server was starting arrives here before `initialize`
  // was answered, and the provider does not exist until it has been.
  await target.ready;
  if (!target.supports("codeLensProvider")) return null;
  // Every lens is a position, so the server has to be looking at the document
  // those positions are in. The library's own sync is debounced by 500 ms, and
  // a lens placed against the document as it was two keystrokes ago sits above
  // the wrong function.
  target.sync();
  try {
    const res = await target.request<unknown>("textDocument/codeLens", {
      textDocument: { uri: pathToUri(path) },
    });
    const resolved = await resolveTitles(target, normalizeCodeLenses(res));
    // An untitled lens has nothing to draw, and a block widget with no content
    // is a blank line the user cannot delete.
    return resolved.filter((lens) => lens.title !== null);
  } catch (e) {
    console.warn("textDocument/codeLens failed", path, e);
    return null;
  }
}

// One token per path with a request outstanding, the same guard
// `refreshSemanticTokens` and `rootCallHierarchy` carry.
const pending = new Map<string, number>();

/** The buffer an answer might be painted into, at one moment. `id` is
 *  `state.doc`, held only to be compared by identity: `Text` is immutable, so
 *  that is the only handle CodeMirror offers on "is this still the document I
 *  asked about?". */
export type LensTarget = { id: unknown };

/** Injected rather than reached for, so every branch below can be tested
 *  without standing CodeMirror up. Same shape as `SemanticDeps`. */
export type CodeLensDeps = {
  /** `path`'s buffer as it is now, or null when this answer has nowhere to go.
   *  Called again after the server replies, which is the point: a tab swap
   *  during the round trip is what "a stale reply for a previous tab" means,
   *  and the token below cannot see it because that reply is about a different
   *  path. */
  current: (path: string) => LensTarget | null;
  paint: (path: string, lenses: CodeLensItem[]) => void;
};

export type LensOutcome =
  /** Applied. */
  | "painted"
  /** Typed into while the server answered. Every lens in the reply names a line
   *  of a document that no longer exists. */
  | "moved"
  /** A newer ask for this same path has already been made. */
  | "superseded"
  /** The buffer is not there to paint: closed, or no longer the one on screen. */
  | "gone";

/**
 * Ask for `path`'s lenses and paint them, unless something happened meanwhile.
 *
 * Both guards are load-bearing and neither covers the other. The token is what
 * discards an older reply for *this* file when the answers come back out of
 * order; `current` is what discards a reply for a file that has since left the
 * screen, which the token cannot see because it is keyed on the path and that
 * reply is about a different one.
 *
 * A reply whose document moved is dropped rather than painted a line or two out
 * of place, and nothing re-asks here: the edit that moved it is itself what
 * schedules the next refresh, so re-asking from here would only double it.
 */
export async function refreshCodeLenses(deps: CodeLensDeps, path: string): Promise<LensOutcome> {
  const before = deps.current(path);
  if (!before) return "gone";
  const token = (pending.get(path) ?? 0) + 1;
  pending.set(path, token);
  const lenses = await requestCodeLenses(path);
  if (pending.get(path) !== token) return "superseded";
  pending.delete(path);
  const now = deps.current(path);
  if (!now) return "gone";
  if (now.id !== before.id) return "moved";
  deps.paint(path, lenses ?? []);
  return "painted";
}
