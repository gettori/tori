// Completion for the buffers no language server claims.
//
// The editor's language server covers TS and JS under the project root and
// nothing else, and it brings its own `autocompletion()` along inside
// `client.plugin(uri)` (see `languageServerExtensions` in
// `@codemirror/lsp-client`). Every other buffer, a stylesheet, a Rust file, a
// README, had no completion machinery installed at all, so even the completions
// its own language pack ships were never rendered.
//
// This is that machinery, plus `completeAnyWord` over the buffer's own text. It
// is deliberately *not* installed where a server is claiming the file: a word
// scraped out of the document would sit in the same list as a typed symbol from
// tsserver, and be worth much less.

import {
  autocompletion,
  completeAnyWord,
  completeFromList,
  snippetCompletion,
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);

/**
 * Markdown only, and short on purpose.
 *
 * Snippets are worth having where the syntax is fiddly to type and the same
 * every time, which in a buffer no server claims means link and image
 * punctuation, fences and tables. Word-shaped labels rather than the
 * punctuation itself (`link`, not `[]()`), because the completion list is
 * filtered against what has been typed, and nobody types a bracket expecting a
 * menu.
 */
const MARKDOWN_SNIPPETS: readonly Completion[] = [
  snippetCompletion("[${text}](${url})", { label: "link", detail: "[text](url)", type: "text" }),
  snippetCompletion("![${alt}](${src})", { label: "image", detail: "![alt](src)", type: "text" }),
  snippetCompletion("```${lang}\n${}\n```", { label: "code", detail: "fenced block", type: "text" }),
  snippetCompletion("| ${a} | ${b} |\n| --- | --- |\n| ${} |  |", {
    label: "table",
    detail: "header row and separator",
    type: "text",
  }),
];

function extensionOf(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

/** The sources this buffer adds of its own, on top of whatever its language
 *  pack already registers. Empty when the preference is off. */
function sourcesFor(path: string, on: boolean): CompletionSource[] {
  if (!on) return [];
  const sources: CompletionSource[] = [completeAnyWord];
  if (MARKDOWN_EXTS.has(extensionOf(path))) sources.push(completeFromList(MARKDOWN_SNIPPETS));
  return sources;
}

/**
 * What a buffer gets when no language server has claimed it.
 *
 * `claimed` is asked of the client rather than of the file name, so a file
 * opened before the server was ready is covered until the moment it is not; the
 * caller holds this in a compartment and re-resolves on `onLspChange`.
 *
 * The preference (`settings.editor.wordCompletion`) governs the *sources*, not
 * the machinery. With it off, a stylesheet still completes property names,
 * because those come from `lang-css` and were only ever missing for want of an
 * `autocompletion()` to render them; what goes away is the scraped words, which
 * is the part someone turning it off is turning off.
 */
export function fallbackCompletion(path: string, opts: { on: boolean; claimed: boolean }): Extension {
  if (opts.claimed) return [];
  const sources = sourcesFor(path, opts.on);
  const asLanguageData = sources.map((autocomplete) => ({ autocomplete }));
  return [
    // `selectOnOpen: false` because these are mostly prose buffers. The popup
    // opens on almost every word typed there, and with an option selected the
    // keymap's Enter accepts it instead of breaking the line, which is the one
    // key a paragraph cannot do without. With nothing selected, Enter falls
    // through and arrowing down still accepts.
    autocompletion({ selectOnOpen: false }),
    ...(asLanguageData.length ? [EditorState.languageData.of(() => asLanguageData)] : []),
  ];
}
