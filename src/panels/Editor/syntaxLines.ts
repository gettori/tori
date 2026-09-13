// Lezer over text that is not in an editor: parse it, run the same class
// highlighter the editor's table produces, and hand back one span list per
// line. Behind the fence; `utils/syntaxRows.ts` is the eager door to it.
import type { Language } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { syntaxClassHighlighter } from "./syntaxStyle";

export { languageForPath } from "./languages";

export type Span = { text: string; cls: string | null };

export function tokenLines(text: string, language: Language): Span[][] {
  const lines: Span[][] = [[]];
  const push = (from: number, to: number, cls: string | null) => {
    const parts = text.slice(from, to).split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, cls });
    });
  };
  let at = 0;
  highlightTree(language.parser.parse(text), syntaxClassHighlighter, (from, to, classes) => {
    if (from > at) push(at, from, null);
    push(from, to, classes);
    at = to;
  });
  if (at < text.length) push(at, text.length, null);
  return lines;
}
