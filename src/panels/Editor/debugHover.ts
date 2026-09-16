// What the thing under the pointer is worth, right now.
//
// The one debugger surface that lives in the buffer rather than in the pane,
// and the only one anybody uses without looking away from their code. It is
// deliberately not the LSP hover: that one answers "what is this declared as"
// from a static analysis, this one answers "what is this holding" from a live
// process, and the two are different questions that happen to share a gesture.

import { EditorView, hoverTooltip, type Tooltip } from "@codemirror/view";
import { Facet, type EditorState, type Extension } from "@codemirror/state";

import { debugPaused, fileOnStack } from "../../utils/debugStack";
import { evaluateInFrame } from "../../utils/debugVariables";

/**
 * Which file this buffer holds.
 *
 * CodeMirror state knows a document, never a path, and this hover has to know
 * one: an answer is only meaningful in a file the paused program is actually
 * in. Also what lets a test assert the extension reached the editor at all,
 * which is otherwise invisible ([[lesson_a_registered_command_with_no_caller_is_not_shipped]]).
 */
export const debugHoverFile = Facet.define<string, string | null>({
  combine: (values) => values[0] ?? null,
});

/** Identifier characters, plus the `$` and `_` JavaScript allows in a name. */
const NAME = /[A-Za-z0-9_$]/;

/**
 * The expression under `pos`, walked left through property access.
 *
 * `user.address.city` is one thing to ask about and three words to CodeMirror's
 * own `wordAt`, and asking for `city` alone answers about whatever `city` means
 * at the top of the frame, which is usually nothing. The walk stops at a `(` or
 * a `[`, so a call or an index is never sent: evaluating one would *run* it,
 * and a hover that calls a function is a hover that can change the program.
 */
export function debugExpressionAt(state: EditorState, pos: number): { from: number; to: number; text: string } | null {
  const line = state.doc.lineAt(pos);
  const text = line.text;
  const at = pos - line.from;
  if (at >= text.length && at > 0 && !NAME.test(text[at - 1] ?? "")) return null;

  let to = at;
  while (to < text.length && NAME.test(text[to])) to++;
  let from = at;
  while (from > 0 && NAME.test(text[from - 1])) from--;
  if (from === to) return null;

  // Walk back over `.name` segments only. Anything else ends the expression.
  let start = from;
  while (start > 1 && text[start - 1] === ".") {
    let seg = start - 1;
    while (seg > 0 && NAME.test(text[seg - 1])) seg--;
    if (seg === start - 1) break;
    // A number before the dot is a decimal literal, not a receiver.
    if (/^[0-9]/.test(text[seg])) break;
    start = seg;
  }

  const expression = text.slice(start, to);
  if (!expression || /^[0-9]/.test(expression)) return null;
  return { from: line.from + start, to: line.from + to, text: expression };
}

function tooltipDom(value: string, type: string | null): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-debug-hover";
  if (type) {
    const kind = document.createElement("span");
    kind.className = "cm-debug-hover-type";
    kind.textContent = type;
    dom.appendChild(kind);
  }
  const body = document.createElement("span");
  body.className = "cm-debug-hover-value";
  // textContent rather than innerHTML: the string is whatever the debuggee's
  // own `toString` returned ([[lesson_sanitize_text_you_did_not_author]]).
  body.textContent = value;
  dom.appendChild(body);
  return dom;
}

const hoverTheme = EditorView.baseTheme({
  ".cm-debug-hover": {
    display: "flex",
    gap: "6px",
    alignItems: "baseline",
    padding: "2px 6px",
    fontFamily: "var(--tori-font-mono)",
    fontSize: "var(--tori-text-sm)",
  },
  ".cm-debug-hover-type": { color: "var(--fg-subtle)" },
  ".cm-debug-hover-value": { color: "var(--fg-default)", whiteSpace: "pre-wrap" },
});

/**
 * Evaluate the hovered expression in the selected frame.
 *
 * Gated on the program being paused, and that is the whole of "hovering while
 * running shows nothing": `evaluate` against a running program is refused by
 * some adapters and answers a stale frame in others, and neither is worth
 * putting under someone's pointer.
 */
export async function debugTooltipAt(state: EditorState, pos: number): Promise<Tooltip | null> {
  if (!debugPaused()) return null;
  // Only in a file the pause is actually in. A stopped program makes every
  // buffer answerable otherwise, and `count` in an unrelated file would render
  // the frame's `count` with nothing on screen saying it is a different one.
  const path = state.facet(debugHoverFile);
  if (!path || !fileOnStack(path)) return null;
  const found = debugExpressionAt(state, pos);
  if (!found) return null;
  const answer = await evaluateInFrame(found.text);
  if (!answer) return null;
  return {
    pos: found.from,
    end: found.to,
    above: true,
    create: () => ({ dom: tooltipDom(answer.value, answer.type) }),
  };
}

export function debugHover(path: string): Extension {
  return [
    debugHoverFile.of(path),
    hoverTooltip((view, pos) => debugTooltipAt(view.state, pos)),
    hoverTheme,
  ];
}
