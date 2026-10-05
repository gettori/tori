// Tori's own language-server completion source, and the reason the client's
// extension list is built by hand instead of spread from
// `languageServerExtensions()`.
//
// The library's `serverCompletion()` applies `additionalTextEdits` when they
// arrive in the *first* completion reply, and declares no `resolveSupport` and
// never sends `completionItem/resolve`. That is exactly where tsserver puts the
// import line: `import { useMemo } from "react"` is the expensive half of the
// answer, so a conformant server leaves it out of a list of two hundred items
// and hands it over only when one is chosen. So auto-import is missing today
// for a completely conformant reason, on both sides.
//
// There is no hook to add: the library builds each option's `apply` while
// mapping the reply, and `apply` is synchronous, so nothing between the reply
// and the commit can await a resolve. Owning the source is the smallest change
// that can send that second request at all, which is why this file is mostly a
// re-implementation of `serverCompletionSource` (`lsp-client/dist/index.js:928`)
// with one thing added.
//
// What is added: after the identifier is inserted, the item is resolved and any
// `additionalTextEdits` that come back are dispatched as a second transaction.
// The insertion never waits on the server, so a resolve that is refused, slow,
// or answered by a server that has no `resolveProvider` costs nothing but the
// import line - the identifier is already typed either way.

import {
  autocompletion,
  insertCompletionText,
  pickedCompletion,
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { EditorState, type Extension, type Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { LSPPlugin } from "@codemirror/lsp-client";

/** An LSP position and a text edit, as a completion reply carries them. */
type LspPosition = { line: number; character: number };
type LspRange = { start: LspPosition; end: LspPosition };
type LspTextEdit = { range: LspRange; newText: string };

/** The fields of a `CompletionItem` this source reads. Everything else on the
 *  item is carried through to `completionItem/resolve` untouched, because the
 *  server round-trips its own `data` through it. */
type CompletionItem = {
  label: string;
  filterText?: string;
  kind?: number;
  detail?: string;
  sortText?: string;
  insertText?: string;
  textEditText?: string;
  insertTextFormat?: number;
  commitCharacters?: string[];
  documentation?: unknown;
  textEdit?: { newText: string; range?: LspRange; insert?: LspRange; replace?: LspRange };
  additionalTextEdits?: LspTextEdit[];
  data?: unknown;
};

type CompletionListReply = {
  items: CompletionItem[];
  isIncomplete?: boolean;
  itemDefaults?: {
    editRange?: LspRange | { insert: LspRange; replace: LspRange };
    insertTextFormat?: number;
    commitCharacters?: string[];
  };
};

/**
 * `additionalTextEdits` and nothing else.
 *
 * `resolveSupport` is a licence, not a request: it tells the server which
 * properties it may leave out of the first reply because the client will come
 * back for them. Declaring `documentation` or `detail` here would license a
 * server to drop the docs from every item in the list, and Tori resolves only
 * on commit - so the popup would show nothing for anything the user had not
 * already accepted, which is backwards.
 */
export const completionClientCapabilities = {
  clientCapabilities: {
    textDocument: {
      completion: {
        completionItem: {
          resolveSupport: { properties: ["additionalTextEdits"] },
        },
      },
    },
  },
};

/**
 * How long the import line is worth waiting for.
 *
 * Deliberately not the per-server request timeout, which is 20 s for tsserver
 * and 90 s for rust-analyzer because it also covers `initialize` on a cold
 * index. An edit that lands a minute after the identifier does not read as a
 * late auto-import; it reads as the editor typing by itself, into whatever the
 * caret has moved on to.
 */
export const RESOLVE_TIMEOUT_MS = 2000;

/** LSP's snippet syntax to CodeMirror's: drop backslashes before `$}\`, which
 *  CodeMirror does not treat as escapes, and expand `$1` to `${1}`. Copied from
 *  the library, which is where the exact set came from. */
export function lspToSnippet(text: string): string {
  return text.replace(/\\([$}\\])|\$(\d+)/g, (_m, esc, field) => esc || `\${${field}}`);
}

/** What an item inserts, in the order LSP says to prefer. */
export function insertTextOf(item: CompletionItem): string {
  return item.textEdit?.newText || item.textEditText || item.insertText || item.label;
}

const KIND_TO_TYPE: Record<number, string> = {
  1: "text",
  2: "method",
  3: "function",
  4: "class", // Constructor
  5: "property", // Field
  6: "variable",
  7: "class",
  8: "interface",
  9: "namespace", // Module
  10: "property",
  11: "keyword", // Unit
  12: "constant", // Value
  13: "constant", // Enum
  14: "keyword",
  16: "constant", // Color
  20: "constant", // EnumMember
  21: "constant",
  22: "class", // Struct
  25: "type", // TypeParameter
};

/** An offset for an LSP position, or null when the position names somewhere
 *  the document does not have. A server working from a stale copy can send
 *  one, and `Text.line` throws rather than clamping. */
export function offsetOf(doc: Text, pos: LspPosition): number | null {
  if (pos.line < 0 || pos.line >= doc.lines) return null;
  const line = doc.line(pos.line + 1);
  if (pos.character < 0 || pos.character > line.length) return null;
  return line.from + pos.character;
}

/**
 * The range a completion replaces, by LSP's own precedence: the list's
 * `editRange` default, then the first item's own `textEdit` range, then the
 * word under the caret.
 *
 * Line-relative like the library's, because both ends of a completion range are
 * on the caret's line by construction.
 */
export function completionResultRange(
  cx: CompletionContext,
  result: CompletionListReply,
): { from: number; to: number } {
  if (!result.items.length) return { from: cx.pos, to: cx.pos };
  const defaultRange = result.itemDefaults?.editRange;
  const item0 = result.items[0];
  const range = defaultRange
    ? "insert" in defaultRange
      ? defaultRange.insert
      : defaultRange
    : item0.textEdit
      ? "range" in item0.textEdit && item0.textEdit.range
        ? item0.textEdit.range
        : (item0.textEdit.insert ?? null)
      : null;
  if (!range) return cx.state.wordAt(cx.pos) || { from: cx.pos, to: cx.pos };
  const line = cx.state.doc.lineAt(cx.pos);
  return { from: line.from + range.start.character, to: line.from + range.end.character };
}

/** A `validFor` regexp covering the non-word prefixes the list actually uses,
 *  so typing `.` or `#` does not throw the whole list away. The library's, kept
 *  because dropping it would make every keystroke a new request. */
export function prefixRegexp(items: CompletionItem[]): RegExp {
  const step = Math.ceil(items.length / 50);
  const prefixes: string[] = [];
  for (let i = 0; i < items.length; i += step) {
    const text = insertTextOf(items[i]);
    if (!/^\w/.test(text)) {
      const prefix = /^[^\w]*/.exec(text)![0];
      if (prefixes.indexOf(prefix) < 0) prefixes.push(prefix);
    }
  }
  if (!prefixes.length) return /^\w*$/;
  const escape = (s: string) => s.replace(/[^\w\s]/g, "\\$&");
  return new RegExp("^(?:" + prefixes.map(escape).join("|") + ")?\\w*$");
}

// ------------------------------------------- the request

function shouldTrigger(plugin: LSPPlugin, character: string): string | null {
  const triggers = plugin.client.serverCapabilities?.completionProvider?.triggerCharacters;
  if (triggers && triggers.indexOf(character) > -1) return "triggerCharacter";
  if (/[a-zA-Z_]/.test(character)) return "identifier";
  return null;
}

function requestCompletions(
  plugin: LSPPlugin,
  pos: number,
  context: unknown,
  abort: AbortSignal | null,
): Promise<CompletionListReply | CompletionItem[] | null> {
  // Only once the server has actually answered `initialize`: a null capability
  // set means nothing has been advertised yet, not that nothing is offered.
  const caps = plugin.client.serverCapabilities;
  if (caps && !caps.completionProvider) return Promise.resolve(null);
  plugin.client.sync();
  const params = {
    position: plugin.toPosition(pos),
    textDocument: { uri: plugin.uri },
    context,
  };
  if (abort) abort.addEventListener("abort", () => plugin.client.cancelRequest(params));
  return plugin.client.request("textDocument/completion", params);
}

// ------------------------------------------- the resolve

/** Whether asking is worth a round trip: the server offers `resolveProvider`,
 *  and the item did not already come with its edits. An item that carried them
 *  in the list has nothing left to fetch. */
function worthResolving(plugin: LSPPlugin, item: CompletionItem): boolean {
  if (item.additionalTextEdits?.length) return false;
  return plugin.client.serverCapabilities?.completionProvider?.resolveProvider === true;
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`completionItem/resolve took longer than ${ms}ms`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Fetch the chosen item's `additionalTextEdits` and put them in the document.
 *
 * Ordering, and each step is load-bearing:
 *
 *   1. `sync()`, so the server computes the import against a document that
 *      already contains the identifier. Without it tsserver answers from the
 *      text before the commit and can decide no import is needed at all.
 *   2. take the mapping *after* the sync, so it starts from the document the
 *      server is about to be told about, and `getMapping` composes in whatever
 *      is typed while the request is out.
 *   3. all-or-nothing. An import half-placed is worse than none, because
 *      nothing on screen says which half.
 *
 * Never throws and never opens a dialog. The identifier is already in the
 * document by the time this runs, so every failure here is the absence of a
 * convenience, not a broken edit.
 */
async function applyResolvedEdits(plugin: LSPPlugin, item: CompletionItem, view: EditorView): Promise<void> {
  const { client, uri } = plugin;
  client.sync();
  const mapping = client.workspaceMapping();
  try {
    const resolved = await withTimeout(
      client.request<CompletionItem, CompletionItem | null>("completionItem/resolve", item),
      RESOLVE_TIMEOUT_MS,
      // Say so rather than just walking away. The request is matched by the
      // params object it was sent with, and a server still computing an import
      // for a keystroke that has already been answered without one is doing
      // work for nobody - on the same thread as the next completion.
      () => client.cancelRequest(item),
    );
    const edits = resolved?.additionalTextEdits;
    if (!edits?.length) return;

    // The view is reused across tabs (one `EditorView`, reconfigured), so by
    // now it can be showing a different file entirely. Its plugin is rebuilt
    // per buffer, so an identity check is the cheapest honest answer to "is
    // this still the document I asked about".
    if (LSPPlugin.get(view) !== plugin) return;

    // All-or-nothing, and it costs no check of its own: `mapPosition` throws
    // for a line the document does not have, one `dispatch` for the whole set
    // means CodeMirror refuses an invalid range before anything is applied, and
    // either throw lands in the catch below. A hand-written bounds check here
    // would be unreachable - which was worth finding out before writing one,
    // since an unreachable guard reads like the thing keeping you safe.
    const changes: { from: number; to: number; insert: string }[] = [];
    for (const edit of edits) {
      if (!edit?.range) throw new Error("a resolved edit carried no range");
      changes.push({
        from: mapping.mapPosition(uri, edit.range.start),
        to: mapping.mapPosition(uri, edit.range.end),
        insert: edit.newText ?? "",
      });
    }
    view.dispatch({ changes, userEvent: "lsp.autoImport" });
  } catch (e) {
    // One line, no dialog. A server that cannot resolve is a server that
    // completes without imports, which is what today already does.
    console.warn("completionItem/resolve failed", e);
  } finally {
    mapping.destroy();
  }
}

// ------------------------------------------- the apply functions

/** An edit an item carried with the list, as an offset range in the document
 *  the completion was requested against. */
type CarriedEdit = { from: number; to: number; text: string };

/** How the document has moved since the request, while the popup stayed open.
 *  A `ChangeDesc`, structurally, so nothing here needs a CodeMirror import it
 *  would otherwise not have. */
type Mapped = {
  touchesRange: (from: number, to: number) => boolean | "cover";
  mapPos: (pos: number, assoc: number) => number;
} | null;

/** Bring the carried edits up to date with the current document, dropping any
 *  the user has since typed inside - editing there would put the import where
 *  their cursor has been. */
function placeCarried(edits: CarriedEdit[], mapped: Mapped): { from: number; to: number; insert: string }[] {
  const changes: { from: number; to: number; insert: string }[] = [];
  for (const edit of edits) {
    let start = edit.from;
    let end = edit.to;
    if (mapped) {
      if (mapped.touchesRange(start, end)) continue;
      const len = end - start;
      start = mapped.mapPos(start, 1);
      end = start + len;
    }
    changes.push({ from: start, to: end, insert: edit.text });
  }
  return changes;
}

/** The library's `applyEdits`: insert the completion text, then place the edits
 *  the first reply already carried. */
function applyWithEdits(edits: CarriedEdit[], text: string, mapped: Mapped) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    view.dispatch(insertCompletionText(view.state, text, from, to), { changes: placeCarried(edits, mapped) });
  };
}

/**
 * The same, for an item whose text is a snippet.
 *
 * The library has no such case: its snippet branch wins outright and the edits
 * an item carried are dropped, and since `worthResolving` also declines an item
 * that already has edits, nothing else would fetch them either. So a snippet
 * completion needing an import silently never got one, twice over.
 *
 * A second dispatch rather than one, because `snippet()` dispatches for itself.
 * That means the carried positions have to clear the snippet's own insertion,
 * which is exactly one contiguous replacement of `[from, to)` - so its effect on
 * anything after it is a single length delta, and an edit landing *inside* what
 * the snippet just replaced is one to drop rather than to place.
 */
function applySnippetWithEdits(edits: CarriedEdit[], text: string, mapped: Mapped) {
  const expand = snippet(lspToSnippet(text));
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    const before = view.state.doc.length;
    expand(view, completion, from, to);
    if (!edits.length) return;
    const delta = view.state.doc.length - before;
    const changes = placeCarried(edits, mapped)
      .filter((c) => c.from >= to || c.to <= from)
      .map((c) => (c.from >= to ? { ...c, from: c.from + delta, to: c.to + delta } : c));
    if (changes.length) view.dispatch({ changes });
  };
}

/** One option's carried edits, plus how to rebuild its `apply` for a newer
 *  mapping. The rebuild is held rather than inferred, so remapping a snippet
 *  option does not quietly turn it into a plain insertion. */
type ExtraEdit = { index: number; rebuild: (mapped: Mapped) => Completion["apply"] };

/** The library's `resultMapper`: as the document changes under an open popup,
 *  re-derive each option's `apply` so its extra edits still land where they
 *  were meant to. */
function resultMapper(
  changes: { composeDesc: (other: unknown) => unknown } | null,
  extraEdits: ExtraEdit[],
): NonNullable<CompletionResult["map"]> {
  return (result, newChanges) => {
    const composed = (changes ? changes.composeDesc(newChanges) : newChanges) as never;
    const options = result.options.slice();
    for (const { index, rebuild } of extraEdits) {
      options[index] = { ...options[index], apply: rebuild(composed) };
    }
    return { ...result, options, map: resultMapper(composed, extraEdits) };
  };
}

function renderDocInfo(plugin: LSPPlugin, doc: unknown): HTMLElement {
  const elt = document.createElement("div");
  elt.className = "cm-lsp-documentation cm-lsp-completion-documentation";
  elt.innerHTML = plugin.docToHTML(doc as never);
  return elt;
}

// ------------------------------------------- the source

/**
 * The completion source Tori installs in place of `serverCompletionSource`.
 *
 * Everything except the resolve is the library's behaviour, deliberately: the
 * point of owning this is one added round trip, not a different completion
 * experience.
 */
export const toriCompletionSource: CompletionSource = (context) => {
  const plugin = context.view && LSPPlugin.get(context.view);
  if (!plugin) return null;
  const triggerChar = context.state.sliceDoc(context.pos - 1, context.pos);
  const triggerReason = context.explicit ? "invoked" : shouldTrigger(plugin, triggerChar);
  if (!triggerReason) return null;
  const completionContext =
    triggerReason === "triggerCharacter" ? { triggerKind: 2, triggerCharacter: triggerChar } : { triggerKind: 1 };

  return requestCompletions(plugin, context.pos, completionContext, context as unknown as AbortSignal).then(
    (reply) => {
      if (!reply) return null;
      const result: CompletionListReply = Array.isArray(reply) ? { items: reply } : reply;
      const { from, to } = completionResultRange(context, result);
      const defaultCommitChars = result.itemDefaults?.commitCharacters;
      const extraEdits: ExtraEdit[] = [];

      const options: Completion[] = result.items.map((item, i) => {
        const text = insertTextOf(item);
        const option: Completion = {
          label: item.filterText || item.label,
          displayLabel: item.label,
          type: item.kind ? KIND_TO_TYPE[item.kind] : undefined,
        };
        const insertTextFormat = item.insertTextFormat ?? result.itemDefaults?.insertTextFormat;
        if (item.commitCharacters && item.commitCharacters !== defaultCommitChars) {
          option.commitCharacters = item.commitCharacters;
        }
        if (item.detail) option.detail = item.detail;
        if (item.sortText) option.sortText = item.sortText;

        // Read once, for whichever branch below wants them: an item may be a
        // snippet *and* carry an import, and reading them only in the
        // non-snippet branch is how the library loses that case.
        const carried: CarriedEdit[] = [];
        for (const edit of item.additionalTextEdits ?? []) {
          const editFrom = offsetOf(context.state.doc, edit.range.start);
          const editTo = offsetOf(context.state.doc, edit.range.end);
          if (editFrom != null && editTo != null) carried.push({ from: editFrom, to: editTo, text: edit.newText });
        }

        let base: Completion["apply"];
        if (insertTextFormat === 2) {
          const rebuild = (mapped: Mapped) => applySnippetWithEdits(carried, text, mapped);
          if (carried.length) extraEdits.push({ index: i, rebuild });
          base = rebuild(null);
        } else if (carried.length) {
          const rebuild = (mapped: Mapped) => applyWithEdits(carried, text, mapped);
          extraEdits.push({ index: i, rebuild });
          base = rebuild(null);
        } else if (option.label !== text) {
          base = text;
        }

        // The one difference from the library. Wrapped rather than branched
        // into each case above, so the snippet path gets its import too: an
        // item is not less likely to need one for having placeholders in it.
        if (worthResolving(plugin, item)) {
          const inner = base;
          option.apply = (view, c, f, t) => {
            if (typeof inner === "function") inner(view, c, f, t);
            // The default apply, done by hand because the wrapper has taken it
            // over - annotation included, since that is the half CodeMirror
            // adds around `insertCompletionText` rather than inside it, and
            // `activateOnCompletion` is the thing that reads it.
            else {
              view.dispatch({
                ...insertCompletionText(view.state, inner ?? text, f, t),
                annotations: pickedCompletion.of(c),
              });
            }
            void applyResolvedEdits(plugin, item, view);
          };
        } else if (base !== undefined) {
          option.apply = base;
        }

        if (item.documentation) option.info = () => renderDocInfo(plugin, item.documentation);
        return option;
      });

      return {
        from,
        to,
        options,
        commitCharacters: defaultCommitChars,
        validFor: result.isIncomplete ? undefined : prefixRegexp(result.items),
        map: extraEdits.length ? resultMapper(null, extraEdits) : undefined,
      };
    },
    (err: unknown) => {
      // -32800 is RequestCancelled, which is what an abort produces and not
      // something to report.
      if (err && typeof err === "object" && "code" in err && (err as { code: number }).code === -32800) return null;
      throw err;
    },
  );
};

/** What replaces `serverCompletion()` in the client's extension list. */
export function toriCompletion(): Extension {
  const data = [{ autocomplete: toriCompletionSource }];
  return [autocompletion(), EditorState.languageData.of(() => data)];
}
