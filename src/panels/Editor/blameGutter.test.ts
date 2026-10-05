import { describe, it, expect } from "vite-plus/test";
import { EditorState, Compartment } from "@codemirror/state";
import {
  blameExtension,
  agentAtLine,
  agentEffect,
  blameAtLine,
  blameEffect,
  blameLabel,
  inlineBlameDecorations,
} from "./blameGutter";
import { UNCOMMITTED, type Blame, type BlameCommit } from "../../utils/blame";
import type { AgentLines, AgentTurn } from "../../utils/agentLines";

// Blame is read once per file per HEAD, and after that the *lines* move while
// the data stands still. These tests are about that movement, and they run
// against a bare EditorState: no view, no DOM, no CodeMirror rendering. The
// mapping is CM6 state, so state is where it can be proven.

const NOW = 1_800_000_000;
const DAY = 86_400;

const commit = (n: number, daysAgo: number): BlameCommit => ({
  sha: `${n}`.repeat(40),
  short: `${n}`.repeat(7),
  author: `author ${n}`,
  time: NOW - daysAgo * DAY,
  summary: `commit ${n}`,
});

/** A blame for `lines.length` lines, one commit index per line. */
function blameOf(perLine: number[], commits: BlameCommit[]): Blame {
  return { head: "h".repeat(40), lines: perLine, commits };
}

function stateWith(doc: string, blame: Blame): EditorState {
  const start = EditorState.create({ doc, extensions: [blameExtension()] });
  return start.update({ effects: blameEffect(start, blame) }).state;
}

const THREE = ["one", "two", "three"].join("\n");
const COMMITS = [commit(1, 2), commit(2, 400)];

describe("blame positions as the buffer changes", () => {
  it("reads each line's own commit", () => {
    const state = stateWith(THREE, blameOf([0, 0, 1], COMMITS));

    expect(blameAtLine(state, 1)?.short).toBe("1111111");
    expect(blameAtLine(state, 2)?.short).toBe("1111111");
    expect(blameAtLine(state, 3)?.short).toBe("2222222");
    expect(blameAtLine(state, 4)).toBeNull();
  });

  it("keeps a line's blame its own after ten lines are inserted above it", () => {
    // The verify. Nothing is re-read here: the markers ride the same ChangeSet
    // the document does, which is the entire reason blame survives typing.
    const state = stateWith(THREE, blameOf([0, 0, 1], COMMITS));
    const inserted = `${"filler\n".repeat(10)}`;
    const after = state.update({ changes: { from: state.doc.line(2).from, insert: inserted } }).state;

    expect(after.doc.lines).toBe(13);
    // "three" moved from line 3 to line 13 and kept its commit.
    expect(after.doc.line(13).text).toBe("three");
    expect(blameAtLine(after, 13)?.short).toBe("2222222");
    expect(after.doc.line(1).text).toBe("one");
    expect(blameAtLine(after, 1)?.short).toBe("1111111");
  });

  it("gives the lines you just typed no commit at all", () => {
    // Which is how the local uncommitted set is recomputed: not by re-blaming,
    // but by the absence of a marker where nothing was mapped.
    const state = stateWith(THREE, blameOf([0, 0, 1], COMMITS));
    const after = state.update({ changes: { from: state.doc.line(2).from, insert: "fresh\nalso fresh\n" } }).state;

    expect(after.doc.line(2).text).toBe("fresh");
    expect(blameAtLine(after, 2)).toBeNull();
    expect(blameAtLine(after, 3)).toBeNull();
    expect(blameAtLine(after, 4)?.short).toBe("1111111");
  });

  it("keeps the lines below a deletion attached to their own commits", () => {
    const state = stateWith(THREE, blameOf([0, 0, 1], COMMITS));
    const after = state.update({ changes: { from: 0, to: state.doc.line(2).from } }).state;

    expect(after.doc.line(1).text).toBe("two");
    expect(blameAtLine(after, 1)?.short).toBe("1111111");
    expect(blameAtLine(after, 2)?.short).toBe("2222222");
  });

  it("leaves an uncommitted line bare rather than marking it as a commit", () => {
    // git names it with an all-zero sha and an author of "Not Committed Yet",
    // neither of which is worth a stripe: it is the same state as a line typed
    // a second ago, and two renderings of one fact is one too many.
    const notYet: BlameCommit = { ...commit(0, 0), sha: UNCOMMITTED, short: "0000000" };
    const state = stateWith(THREE, blameOf([0, 1, 1], [COMMITS[0], notYet]));

    expect(blameAtLine(state, 1)?.short).toBe("1111111");
    expect(blameAtLine(state, 2)).toBeNull();
    expect(blameAtLine(state, 3)).toBeNull();
  });

  it("ignores blame for lines the buffer no longer has", () => {
    // The file on disk is longer than the buffer: an unsaved deletion, or a
    // blame read before an external truncation.
    const state = stateWith("only one\n", blameOf([0, 0, 1, 1], COMMITS));

    expect(blameAtLine(state, 1)?.short).toBe("1111111");
    expect(blameAtLine(state, 2)?.short).toBe("1111111");
    expect(blameAtLine(state, 3)).toBeNull();
  });

  it("puts the inline widget on the cursor's line and nowhere else", () => {
    const state = stateWith(THREE, blameOf([0, 0, 1], COMMITS));
    const onThird = state.update({ selection: { anchor: state.doc.line(3).from } }).state;

    const set = inlineBlameDecorations(onThird);
    expect(set.size).toBe(1);
    let at = -1;
    set.between(0, onThird.doc.length, (from) => {
      at = from;
    });
    // At the end of the line, so it reads as an annotation after the code
    // rather than pushing the code sideways.
    expect(at).toBe(onThird.doc.line(3).to);
  });

  it("answers nothing at all when blame is switched off", () => {
    // Off means the extension is not installed, so the field is absent - and
    // asking a state for a field it does not have throws rather than returning
    // nothing. Every caller here goes through `blameAtLine`, so it is the one
    // place that has to know.
    const bare = EditorState.create({ doc: THREE });

    expect(blameAtLine(bare, 1)).toBeNull();
  });
});

describe("switching blame off", () => {
  // The editor holds the whole extension in a compartment for exactly this
  // reason. Gating it *inside* the extension would leave an empty gutter column
  // sitting there, and the widget's plugin still installed and still running.
  function withCompartment() {
    const conf = new Compartment();
    let state = EditorState.create({ doc: THREE, extensions: [conf.of(blameExtension())] });
    state = state.update({ effects: blameEffect(state, blameOf([0, 0, 1], COMMITS)) }).state;
    return { conf, state };
  }

  it("takes the markers and the widget with it, leaving nothing behind", () => {
    const { conf, state } = withCompartment();
    expect(blameAtLine(state, 1)?.short).toBe("1111111");
    expect(inlineBlameDecorations(state).size).toBe(1);

    const off = state.update({ effects: conf.reconfigure([]) }).state;

    expect(blameAtLine(off, 1)).toBeNull();
    expect(inlineBlameDecorations(off).size).toBe(0);
  });

  it("comes back with the same lines when it is switched on again", () => {
    // The markers do not survive the round trip, and should not: the field went
    // away with the extension. The editor re-reads on toggle, and the cache
    // means that costs nothing while HEAD has not moved.
    const { conf, state } = withCompartment();
    const off = state.update({ effects: conf.reconfigure([]) }).state;
    let on = off.update({ effects: conf.reconfigure(blameExtension()) }).state;
    expect(blameAtLine(on, 1)).toBeNull();

    on = on.update({ effects: blameEffect(on, blameOf([0, 0, 1], COMMITS)) }).state;
    expect(blameAtLine(on, 3)?.short).toBe("2222222");
  });
});

describe("the agent turn behind an uncommitted line", () => {
  // The second marker set. It rides the same ChangeSet the first one does, and
  // it only ever speaks where blame is silent - which is exactly the set of
  // lines blame calls uncommitted.
  const TURN_A: AgentTurn = { session_id: "sess-a", prompt_ts: 1700, ordinal: 4 };
  const TURN_B: AgentTurn = { session_id: "sess-b", prompt_ts: 1800, ordinal: 9 };

  function withAgent(doc: string, blame: Blame, agent: AgentLines): EditorState {
    const start = EditorState.create({ doc, extensions: [blameExtension()] });
    return start.update({ effects: [blameEffect(start, blame), agentEffect(start, agent)] }).state;
  }

  const AGENT: AgentLines = { lines: [-1, 0, 1], turns: [TURN_A, TURN_B] };

  it("reads each line's own turn, and none for a line no turn wrote", () => {
    const state = withAgent(THREE, blameOf([0, 0, 1], COMMITS), AGENT);

    expect(agentAtLine(state, 1)).toBeNull();
    expect(agentAtLine(state, 2)?.ordinal).toBe(4);
    expect(agentAtLine(state, 3)?.session_id).toBe("sess-b");
    expect(agentAtLine(state, 4)).toBeNull();
  });

  it("moves with the lines when text is typed above them", () => {
    // The same property blame has, and it has to hold for both sets at once:
    // one of them mapping and the other not would put the two answers on
    // different lines.
    const state = withAgent(THREE, blameOf([0, 0, 1], COMMITS), AGENT);
    const after = state.update({ changes: { from: state.doc.line(2).from, insert: "typed\n" } }).state;

    expect(after.doc.line(3).text).toBe("two");
    expect(agentAtLine(after, 3)?.ordinal).toBe(4);
    // And the line the user just typed belongs to nobody, same as blame.
    expect(agentAtLine(after, 2)).toBeNull();
  });

  it("says nothing when blame is switched off", () => {
    const bare = EditorState.create({ doc: THREE });

    expect(agentAtLine(bare, 1)).toBeNull();
  });

  it("offers a widget on an uncommitted line the agent wrote, and none on a bare one", () => {
    // The precedence itself is asserted where the widget can be rendered
    // (`blameWidget.test.tsx`); what is pinned here is that the second set
    // reaches the decoration at all, without a DOM.
    const notYet: BlameCommit = { ...commit(0, 0), sha: UNCOMMITTED, short: "0000000" };
    const state = withAgent(THREE, blameOf([1, 1, 1], [COMMITS[0], notYet]), AGENT);
    const onSecond = state.update({ selection: { anchor: state.doc.line(2).from } }).state;

    expect(inlineBlameDecorations(onSecond).size).toBe(1);
  });

  it("offers nothing on a line neither a commit nor a turn claims", () => {
    const state = withAgent(THREE, blameOf([], []), AGENT);
    const onFirst = state.update({ selection: { anchor: state.doc.line(1).from } }).state;

    expect(inlineBlameDecorations(onFirst).size).toBe(0);
  });
});

describe("what the inline label says", () => {
  it("names who, how long ago, and what they were doing", () => {
    expect(blameLabel(commit(1, 2), NOW)).toBe("author 1, 2d ago · commit 1");
  });

  it("drops the summary rather than trailing a separator with nothing after it", () => {
    expect(blameLabel({ ...commit(1, 2), summary: "" }, NOW)).toBe("author 1, 2d ago");
  });

  it("says something even for a commit with no author name", () => {
    expect(blameLabel({ ...commit(1, 0), author: "", summary: "" }, NOW)).toBe("unknown, 0s ago");
  });
});
