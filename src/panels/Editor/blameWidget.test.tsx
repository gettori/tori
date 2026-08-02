import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet, type WidgetType } from "@codemirror/view";
import { blameExtension, agentEffect, blameEffect, inlineBlameDecorations } from "./blameGutter";
import { UNCOMMITTED, type Blame, type BlameCommit } from "../../utils/blame";
import type { AgentLines, AgentTurn } from "../../utils/agentLines";

// The half of the inline widget that needs a document: what it renders as, and
// what a click on it does. The mapping and precedence rules live in
// `blameGutter.test.ts`, which runs without a DOM and should stay that way.
//
// `.tsx` for the environment alone - there is no JSX here. The suite splits on
// the extension, so this is how a test asks for jsdom.

const NOW = 1_800_000_000;

const COMMIT: BlameCommit = {
  sha: "1".repeat(40),
  short: "1111111",
  author: "Ada",
  time: NOW - 86_400,
  summary: "the commit",
};
const NOT_YET: BlameCommit = { ...COMMIT, sha: UNCOMMITTED, short: "0000000", summary: "" };

const TURN: AgentTurn = { session_id: "sess-a", prompt_ts: 1700, ordinal: 4 };

const THREE = ["one", "two", "three"].join("\n");

function stateWith(blame: Blame, agent: AgentLines, line: number): EditorState {
  const start = EditorState.create({ doc: THREE, extensions: [blameExtension()] });
  const laid = start.update({ effects: [blameEffect(start, blame), agentEffect(start, agent)] }).state;
  return laid.update({ selection: { anchor: laid.doc.line(line).from } }).state;
}

function widgetOf(set: DecorationSet): WidgetType | null {
  let found: WidgetType | null = null;
  set.between(0, 1e9, (_from, _to, deco) => {
    found = (deco as ReturnType<typeof Decoration.widget>).spec.widget ?? null;
    return false;
  });
  return found;
}

/** The widget's rendered DOM. `toDOM` is typed as taking an `EditorView` that
 *  neither of these widgets reads; building one for a text assertion would mean
 *  mounting the whole editor. */
function domOf(set: DecorationSet): HTMLElement {
  return (widgetOf(set) as unknown as { toDOM(): HTMLElement }).toDOM();
}

const AGENT: AgentLines = { lines: [-1, 0, 0], turns: [TURN] };
const COMMITTED: Blame = { head: "h".repeat(40), lines: [0, 0, 0], commits: [COMMIT] };
const UNCOMMITTED_BLAME: Blame = { head: "h".repeat(40), lines: [0, 0, 0], commits: [NOT_YET] };

describe("the inline widget on the cursor's line", () => {
  it("names the commit when the line has one", () => {
    // The precedence, which is the whole reason the two marker sets coexist: a
    // committed line's author is the commit, whoever typed it first.
    const set = inlineBlameDecorations(stateWith(COMMITTED, AGENT, 2));

    // Not the exact age: `blameLabel` reads the wall clock, which is the
    // reader's question and `blameGutter.test.ts`'s to pin against a fixed one.
    const text = domOf(set).textContent!;
    expect(text).toContain("Ada,");
    expect(text).toContain("the commit");
    expect(text).not.toContain("turn 4");
  });

  it("names the agent turn when the line is not committed yet", () => {
    const set = inlineBlameDecorations(stateWith(UNCOMMITTED_BLAME, AGENT, 2));

    expect(domOf(set).textContent).toBe("sess-a, turn 4");
  });

  it("uses the name the caller knows the chat by", () => {
    const set = inlineBlameDecorations(stateWith(UNCOMMITTED_BLAME, AGENT, 2), {
      nameFor: () => "fix the parser",
    });

    expect(domOf(set).textContent).toBe("fix the parser, turn 4");
  });

  it("hands a click the turn it is labelled with", () => {
    // The click is the point of the widget: the reader wants the conversation
    // that produced the line, and this is the only place the two are connected.
    const opened: AgentTurn[] = [];

    const set = inlineBlameDecorations(stateWith(UNCOMMITTED_BLAME, AGENT, 3), {
      onOpen: (t) => opened.push(t),
    });
    domOf(set).dispatchEvent(new MouseEvent("click"));

    expect(opened).toEqual([TURN]);
  });

  it("is a button, so it can be reached without a mouse", () => {
    const dom = domOf(inlineBlameDecorations(stateWith(UNCOMMITTED_BLAME, AGENT, 2)));

    expect(dom.tagName).toBe("BUTTON");
    // The commit widget refuses pointer events; this one is a target, so it
    // carries the class that takes them back.
    expect(dom.className).toContain("cm-blame-turn");
  });

  it("says nothing on an uncommitted line no turn wrote", () => {
    const set = inlineBlameDecorations(stateWith(UNCOMMITTED_BLAME, AGENT, 1));

    expect(set.size).toBe(0);
  });
});
