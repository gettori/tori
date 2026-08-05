// Asking the server where to peek, and reading the text once it has answered.
//
// Split from the widget for the reason `lspSymbols.ts` is split from the
// outline: deciding *who to ask, what a refusal means, and which reply is still
// current* is a rule with cases in it, and a rule tests without a DOM.
//
// Editor-side, so it may import CodeMirror-adjacent modules; nothing on the
// eager path may import this.

import { invoke } from "@tauri-apps/api/core";
import { liveBufferText } from "./liveBuffers";
import { lspTargetFor } from "./lspClient";
import { pathToUri, uriToPath } from "./swayWorkspace";

/** Which question a peek is asking. */
export type PeekKind = "definition" | "references";

/**
 * One place a peek can show.
 *
 * Lines are 0-based, exactly as the server sent them. Converting to the
 * editor's 1-based numbering happens where it is rendered, so nothing in
 * between has to remember which convention it is holding.
 */
export type PeekLocation = {
  path: string;
  line: number;
  endLine: number;
};

const METHOD: Record<PeekKind, string> = {
  definition: "textDocument/definition",
  references: "textDocument/references",
};

const PROVIDER = {
  definition: "definitionProvider",
  references: "referencesProvider",
} as const;

function locationOf(raw: unknown): PeekLocation | null {
  const entry = raw as {
    uri?: unknown;
    targetUri?: unknown;
    range?: { start?: { line?: unknown }; end?: { line?: unknown } };
    targetRange?: { start?: { line?: unknown }; end?: { line?: unknown } };
    targetSelectionRange?: { start?: { line?: unknown }; end?: { line?: unknown } };
  } | null;
  if (!entry) return null;
  // `Location` and `LocationLink` are both legal answers to the same request,
  // and a server picks per reply rather than per session, so both shapes have
  // to be read here. For a link the *target* range is the one that says where
  // the symbol lives; `originSelectionRange` describes the word clicked on.
  const uri = typeof entry.uri === "string" ? entry.uri : typeof entry.targetUri === "string" ? entry.targetUri : null;
  const range = entry.range ?? entry.targetRange ?? entry.targetSelectionRange;
  if (!uri || !range) return null;
  const path = uriToPath(uri);
  const line = range.start?.line;
  if (!path || typeof line !== "number" || line < 0) return null;
  const rawEnd = range.end?.line;
  const endLine = typeof rawEnd === "number" && rawEnd >= line ? rawEnd : line;
  return { path, line, endLine };
}

/**
 * Every location a reply carries, in the order the server sent them.
 *
 * A malformed entry is dropped rather than throwing: one unreadable location
 * among twenty is a reason to show nineteen, not a reason to show a failure.
 * A reply that is entirely unreadable therefore yields an empty list, which the
 * caller renders as "no results" - the same thing the server saying `null`
 * means to a reader.
 */
export function normalizeLocations(res: unknown): PeekLocation[] {
  if (res == null) return [];
  const list = Array.isArray(res) ? res : [res];
  return list.map(locationOf).filter((l): l is PeekLocation => l !== null);
}

/**
 * The text to render for a peeked file: the open buffer's if one holds it, the
 * file on disk otherwise.
 *
 * Buffer before disk, the same rule the workspace bridge uses. A peek into a
 * background tab with unsaved edits must show what the user typed; reading the
 * disk copy would show them a version of their own file that they cannot see
 * anywhere else and did not ask for.
 */
export async function peekSourceText(path: string): Promise<string | null> {
  const buffered = liveBufferText(path);
  if (buffered != null) return buffered;
  return invoke<string>("fs_read_file", { path }).catch(() => null);
}

// There is exactly one peek widget, so there is exactly one question in flight
// worth answering: whichever was asked last.
//
// **Deliberately not keyed on the question.** Keying on `(kind, path, position)`
// was the first shape of this and it is worthless: two *different* positions get
// two different keys and so never supersede each other, which is precisely the
// case the guard exists for - the caret moved, and the older reply lands last.
let latest = 0;

/**
 * Claim the peek surface, and get back a check for whether the claim still
 * holds.
 *
 * Exported because opening a peek and choosing a different result *inside* one
 * are two claims on the same widget: a separate counter for the second case
 * could disagree with this one, and a slow open would then overwrite a
 * selection the user made after it.
 */
export function claimPeek(): () => boolean {
  const mine = ++latest;
  return () => latest === mine;
}

/**
 * Ask where `position` leads and hand the answer to `publish`, unless a newer
 * ask has been made since.
 *
 * Publishing lives inside the guard rather than in the caller, the way
 * `refreshDocumentSymbols` does it, because that is what makes the guard
 * unskippable: there is no way to ask without going through it. Without it a
 * slow reply for the line the caret *used* to be on lands last and replaces a
 * peek the user opened later, which is a widget showing the right source for
 * the wrong symbol - the failure that looks like a working feature.
 *
 * `publish` is handed the same check, because showing a location means
 * reading its file, and that await is on the far side of this one.
 *
 * Resolves to whether it published. Null through `publish` means "there is no
 * peek to have here", covering the three states a caller cannot act on
 * differently: no server claims the file, the server advertises no provider,
 * or the request failed.
 */
export async function peekAt(
  kind: PeekKind,
  path: string,
  position: { line: number; character: number },
  publish: (locations: PeekLocation[] | null, stillCurrent: () => boolean) => void | Promise<void>,
): Promise<boolean> {
  const current = claimPeek();
  const settle = async (locations: PeekLocation[] | null) => {
    // Superseded: a newer peek is in flight, and its answer is the one the
    // user is waiting for.
    if (!current()) return false;
    await publish(locations, current);
    return true;
  };

  const target = lspTargetFor(path);
  if (!target) return settle(null);
  // Waiting rather than refusing, for `requestDocumentSymbols`'s reason: a peek
  // asked the moment a server came up arrives before `initialize` was answered,
  // and refusing then would make the feature depend on startup timing.
  await target.ready;
  if (!target.supports(PROVIDER[kind])) return settle(null);

  // The reply is a set of positions, so the server has to be looking at the
  // document those positions are in. The library's own sync is debounced by
  // 500 ms, so typing and peeking immediately would otherwise be answered
  // against text the server has not seen.
  target.sync();
  try {
    const res = await target.request<unknown>(METHOD[kind], {
      textDocument: { uri: pathToUri(path) },
      position,
      ...(kind === "references" ? { context: { includeDeclaration: true } } : {}),
    });
    return settle(normalizeLocations(res));
  } catch (e) {
    console.warn(`${METHOD[kind]} failed`, path, e);
    return settle(null);
  }
}
