// One tag table for the editor's HighlightStyle and the `sy-{role}` classes
// App.css maps onto --syntax-* vars, so code drawn outside an EditorView (the
// diff rows) colours a keyword exactly as the editor does. Behind the fence.
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t, tagHighlighter, type Tag } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import { languageForPath } from "./languages";

type Entry = { tag: Tag | readonly Tag[]; color: string; fontStyle?: string };

// Syntax colors read live from the --syntax-* CSS vars set by the theme module
// (src/theme, which derives them from the active palette). Because the values
// are var() references, re-theming on THEME_APPLIED is automatic: the theme
// module rewrites the vars and the browser re-resolves them on the next paint,
// so the editor never needs to reconfigure for a theme change.
// Ordered least to most specific: CodeMirror applies every matching rule, so a
// later rule wins for a tag both cover. `t.function(t.propertyName)` must
// therefore come after `t.propertyName`, or every method reads as a property.
const TABLE: Entry[] = [
  { tag: [t.keyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self], color: "var(--syntax-keyword)" },
  { tag: [t.controlKeyword, t.operatorKeyword], color: "var(--syntax-control)" },
  { tag: [t.operator, t.compareOperator, t.arithmeticOperator, t.logicOperator], color: "var(--syntax-operator)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syntax-string)" },
  { tag: [t.escape, t.character], color: "var(--syntax-escape)" },
  { tag: [t.regexp], color: "var(--syntax-regexp)" },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: "var(--syntax-comment)",
    fontStyle: "italic",
  },
  { tag: [t.number, t.integer, t.float], color: "var(--syntax-number)" },
  { tag: [t.bool, t.null, t.constant(t.variableName), t.standard(t.variableName)], color: "var(--syntax-constant)" },
  { tag: [t.typeName, t.standard(t.typeName)], color: "var(--syntax-type)" },
  { tag: [t.className], color: "var(--syntax-class)" },
  { tag: [t.namespace], color: "var(--syntax-namespace)" },
  { tag: [t.variableName], color: "var(--syntax-variable)" },
  // No parameter rule here. There used to be a `t.local(t.variableName)` one
  // standing in for it, but a grammar cannot tell a parameter from any other
  // block-scoped binding, so it painted a good deal of ordinary local state as
  // parameters. The real answer now comes from the language server, through
  // `semanticHighlight()`, which knows because it resolved the program.
  // Files with no server keep the plain variable colour rather than a guess.
  { tag: [t.propertyName], color: "var(--syntax-property)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--syntax-tag)" },
  { tag: [t.attributeName], color: "var(--syntax-attribute)" },
  {
    tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace, t.squareBracket],
    color: "var(--syntax-punctuation)",
  },
  // Most specific last: these are refinements of tags matched above.
  { tag: [t.function(t.variableName)], color: "var(--syntax-function)" },
  { tag: [t.function(t.propertyName)], color: "var(--syntax-method)" },
  { tag: [t.function(t.definition(t.variableName))], color: "var(--syntax-function)" },
];

const roleOf = (entry: Entry) => /--syntax-([a-z]+)/.exec(entry.color)![1];

export const toriHighlight = HighlightStyle.define(TABLE);

export const SYNTAX_CLASS_PREFIX = "sy-";

export const syntaxClassHighlighter = tagHighlighter(
  TABLE.map((entry) => ({ tag: entry.tag, class: SYNTAX_CLASS_PREFIX + roleOf(entry) })),
);

export const SYNTAX_ROLES: readonly string[] = [...new Set(TABLE.map(roleOf))];

/** A path's language and the colours to paint it with, for a view that wants
 *  both and has no use for the rest of the editing stack. Empty when the
 *  suffix names no language. */
export async function syntaxFor(path: string): Promise<Extension> {
  const language = await languageForPath(path);
  return language ? [language, syntaxHighlighting(toriHighlight)] : [];
}
