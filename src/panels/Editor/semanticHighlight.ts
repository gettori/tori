// Painting a server's semantic tokens over the grammar's guess.
//
// The decisions worth knowing before reading this:
//
//   * **These layer over lexical highlighting, they do not replace it.** The
//     grammar colours every character in the file instantly and offline; the
//     server colours the subset it has actually resolved, hundreds of
//     milliseconds later, and only while it is running. So a token with no
//     semantic answer must keep the colour it already had, which means adding
//     decorations rather than swapping a `HighlightStyle`.
//
//   * **Winning the colour is a matter of nesting, and the nesting runs the
//     opposite way to the intuition.** Overlapping mark decorations become
//     nested spans, and the *innermost* element is the one whose own `color`
//     rule paints the text - specificity across two different elements never
//     enters into it. Higher facet precedence puts a decoration further *in*,
//     not further out. `@codemirror/language` registers its `treeHighlighter` at
//     `Prec.high` (`dist/index.js:1797`), so the field below has to be
//     `Prec.highest` to land inside it; at default precedence it wraps the
//     grammar's span instead and the lexical guess wins every time, which looks
//     exactly like the server never answered. `semanticHighlight.test.tsx`
//     asserts the nesting for that reason.
//
//   * **Tokens map through edits rather than being dropped on one.** A refresh
//     is a round trip to a subprocess. Discarding the decorations on every
//     keystroke would make the file flash back to lexical colours the whole time
//     anyone is typing, so the ranges are mapped through the change and simply
//     go stale until the next answer lands.

import {
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { SEMANTIC_ROLES, tokenClasses, type SemanticToken } from "../../utils/semanticTokens";

/** Replace this buffer's semantic tokens wholesale. There is no incremental
 *  form: the protocol's delta requests are not advertised, so every answer
 *  describes the entire document. */
export const setSemanticTokens = StateEffect.define<SemanticToken[]>();

// One `Decoration` per distinct class string rather than per token. A large
// file is tens of thousands of tokens across a dozen or so classes, and
// `Decoration.mark` with equal specs still produces distinct objects.
const marks = new Map<string, Decoration>();

function markFor(classes: string): Decoration {
  let mark = marks.get(classes);
  if (!mark) {
    mark = Decoration.mark({ class: classes });
    marks.set(classes, mark);
  }
  return mark;
}

/**
 * Decorations for `tokens` against `doc`.
 *
 * Every token is bounds-checked against the document it is being applied to.
 * The server answered about the document as it was when the request went out,
 * and although the caller only applies an answer whose document has not moved,
 * a truncated or malformed response is still a response: a token past the end
 * of a line would otherwise throw inside a state field update, which takes the
 * whole editor down rather than losing one colour.
 */
export function semanticDecorations(doc: Text, tokens: SemanticToken[]): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const token of tokens) {
    const classes = tokenClasses(token);
    if (!classes.length) continue;
    if (token.line < 0 || token.line >= doc.lines) continue;
    // A negative column is reachable without a malformed response: the wire
    // format is deltas, so one bad `deltaStart` walks the running column below
    // zero and every token after it lands on the *previous* line's text.
    if (token.char < 0) continue;
    const line = doc.line(token.line + 1);
    const from = line.from + token.char;
    if (from >= line.to) continue;
    // Clamped to the line rather than allowed to run on: `multilineTokenSupport`
    // is advertised as false, so a token crossing a line break is a server
    // ignoring that, and a mark spanning half the file is worse than a short one.
    const to = Math.min(from + token.length, line.to);
    if (to <= from) continue;
    ranges.push(markFor(classes.join(" ")).range(from, to));
  }
  // Sorted here rather than trusted: the encoding requires ascending order, but
  // an unsorted set is a thrown error inside a state field, not a wrong colour.
  return Decoration.set(ranges, true);
}

const semanticField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSemanticTokens)) return semanticDecorations(tr.state.doc, effect.value);
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** How many semantic decorations this state is holding. What a caller can ask
 *  without the field itself becoming part of the module's surface. */
export function semanticTokenCount(state: EditorState): number {
  return state.field(semanticField, false)?.size ?? 0;
}

// One rule per role the type map can produce, generated from that map so a role
// cannot be added on one side and forgotten on the other. Written against
// `.cm-content` rather than the bare class so that on the one occasion the two
// decorations cover exactly the same run and CodeMirror emits a single element
// carrying both classes, specificity settles it the same way nesting does
// everywhere else. `!important` is not needed and not used.
const roleRules = Object.fromEntries(
  SEMANTIC_ROLES.map((role) => [`.cm-content .cm-sem-${role}`, { color: `var(--syntax-${role})` }]),
);

const semanticTheme = EditorView.theme({
  ...roleRules,
  // Composes with whatever the type painted: a deprecated method still reads as
  // a method, it is just struck through. Nothing a grammar can express, which
  // is most of the argument for asking a server at all.
  ".cm-content .cm-sem-deprecated": { textDecoration: "line-through" },
});

/** The per-buffer extension. `Prec.highest` is load-bearing, not tidiness: it
 *  is what nests these marks inside `treeHighlighter`'s (itself `Prec.high`),
 *  and the inner span is the one that gets to colour the text. */
export function semanticHighlight(): Extension {
  return [Prec.highest(semanticField), semanticTheme];
}
