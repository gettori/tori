// The diagnostics a code action is asked about, kept exactly as the server sent
// them.
//
// `textDocument/codeAction` carries a `context.diagnostics` list, and for a
// quick fix it is the whole question: tsserver reads each diagnostic's `code`
// to decide which fixes exist, and rust-analyzer reads `data`. Neither survives
// the trip through CodeMirror. `serverDiagnostics()` converts a published
// diagnostic to `{from, to, severity, message}` and drops the rest
// (`lsp-client/dist/index.js:1827-1834`), so reconstructing the context from
// the lint state would send every server a list it cannot match anything
// against, and quick fixes would come back empty against a *correct* server.
//
// So the raw list is kept here, captured off the same notification the library
// renders from. This is not a second diagnostics store: nothing reads it to
// display anything, and `utils/diagnostics.ts` remains the one the Problems
// panel and the gutter answer to.

import type { LspPosition } from "./workspaceEdit";

export type LspRange = { start: LspPosition; end: LspPosition };

/** A published diagnostic, held opaquely. Only `range` is read here; the rest
 *  is the server's own vocabulary and is handed straight back to it. */
export type RawDiagnostic = { range?: LspRange; [key: string]: unknown };

// Keyed by the URI the server used, which is the URI a code action will be
// asked about, so no spelling is normalised in between.
const byUri = new Map<string, RawDiagnostic[]>();

/**
 * Record what a server just published for one file.
 *
 * An empty list deletes rather than storing, because "this file has no
 * problems" is the resting state of almost every file a server ever looks at,
 * and a monorepo-wide publish would otherwise leave an entry per file in the
 * project for the lifetime of the session.
 */
export function rememberDiagnostics(uri: string, diagnostics: RawDiagnostic[]): void {
  if (diagnostics.length) byUri.set(uri, diagnostics);
  else byUri.delete(uri);
}

/** Forget everything. What full teardown calls: every diagnostic held here
 *  describes a file some now-dead server had an opinion about. */
export function clearDiagnosticContext(): void {
  byUri.clear();
}

/** Forget one evicted project's files, by URI prefix (its root URI plus a
 *  trailing slash, so `/a/repo-two` never matches `/a/repo`). The warm-root
 *  policy stops servers per project now, and the survivors' context has to
 *  survive with them. */
export function dropDiagnosticContextUnder(uriPrefix: string): void {
  for (const uri of [...byUri.keys()]) {
    if (uri.startsWith(uriPrefix)) byUri.delete(uri);
  }
}

/**
 * An `LSPClientExtension` that records every publish and lets the library
 * render it.
 *
 * Returning false is the whole trick: the client tries each extension's handler
 * in order and stops at the first that returns true
 * (`lsp-client/dist/index.js:670-676`), so this has to run *before*
 * `serverDiagnostics()` and decline to consume the notification. Placed ahead
 * of `languageServerExtensions()` in the client's list for that reason, and it
 * is the reason the order there is not arbitrary.
 */
export const diagnosticContextCapture = {
  notificationHandlers: {
    "textDocument/publishDiagnostics": (_client: unknown, params: unknown): boolean => {
      const p = params as { uri?: unknown; diagnostics?: unknown } | null;
      if (typeof p?.uri === "string") {
        rememberDiagnostics(p.uri, Array.isArray(p.diagnostics) ? (p.diagnostics as RawDiagnostic[]) : []);
      }
      return false;
    },
  },
};

const before = (a: LspPosition, b: LspPosition) =>
  a.line < b.line || (a.line === b.line && a.character < b.character);

/**
 * The diagnostics overlapping `range` in `uri`, in the shape they arrived in.
 *
 * Touching counts as overlapping: a caret sitting at either end of a squiggle
 * is the position someone asks for a fix from, and an exclusive comparison
 * would answer nothing for exactly that caret.
 *
 * These positions are the server's own, from the version it last published
 * against, while `range` comes from the document as it is now. An edit made
 * since can therefore include or miss one at the margin. Left as it is on
 * purpose: the alternative is to hold a mapping open across every keystroke,
 * and the server recomputes the fix from its own state anyway - the list is
 * what tells it *which* problem is being asked about, not where.
 */
export function diagnosticsIn(uri: string, range: LspRange): RawDiagnostic[] {
  const all = byUri.get(uri);
  if (!all) return [];
  return all.filter((d) => {
    if (!d.range) return false;
    return !before(d.range.end, range.start) && !before(range.end, d.range.start);
  });
}
