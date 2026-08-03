// What a buffer with no language server behind it is offered, and what it is
// not.
//
// Asserted by running the sources the extension registers, rather than by
// looking at the returned array: "the extension is installed" and "typing `al`
// offers `alpha`" are different claims, and only the second is the ticket.
import { describe, it, expect } from "vitest";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import {
  CompletionContext,
  startCompletion,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { fallbackCompletion } from "./fallbackCompletion";

const PROSE = "alpha beta gamma\nal";

function stateWith(extensions: Extension, doc = PROSE): EditorState {
  return EditorState.create({ doc, selection: { anchor: doc.length }, extensions });
}

function sourcesIn(state: EditorState): readonly CompletionSource[] {
  return state.languageDataAt<CompletionSource>("autocomplete", state.doc.length);
}

/** Every label the buffer's own sources offer at the cursor. */
async function labelsIn(state: EditorState): Promise<string[]> {
  const context = new CompletionContext(state, state.doc.length, false);
  const results = await Promise.all(sourcesIn(state).map((source) => source(context)));
  return results
    .filter((r): r is CompletionResult => !!r && "options" in r)
    .flatMap((r) => r.options.map((o) => String(o.label)));
}

/** Whether the completion machinery itself is installed, which is what lets a
 *  language pack's own sources render at all. */
const canStartCompletion = (state: EditorState) =>
  state
    .facet(keymap)
    .flat()
    .some((b) => b.run === startCompletion);

describe("a buffer no language server claims", () => {
  it("offers words from its own text", async () => {
    const state = stateWith(fallbackCompletion("/notes/todo.txt", { on: true, claimed: false }));
    expect(await labelsIn(state)).toContain("alpha");
  });

  it("keeps the completion machinery but drops the words when the key is off", async () => {
    const state = stateWith(fallbackCompletion("/notes/todo.txt", { on: false, claimed: false }));
    expect(await labelsIn(state)).toEqual([]);
    // Not an empty extension: a stylesheet's property completions come from
    // `lang-css` and were only ever missing for want of this.
    expect(canStartCompletion(state)).toBe(true);
  });

  it("adds markdown snippets in a markdown buffer, and nowhere else", async () => {
    const md = stateWith(fallbackCompletion("/docs/readme.md", { on: true, claimed: false }), "lin");
    expect(await labelsIn(md)).toContain("link");

    const txt = stateWith(fallbackCompletion("/notes/todo.txt", { on: true, claimed: false }), "lin");
    expect(await labelsIn(txt)).not.toContain("link");
  });
});

describe("a buffer the server has claimed", () => {
  it("is given nothing at all, machinery included", async () => {
    // tsserver brings its own `autocompletion()` inside `client.plugin(uri)`, so
    // a second one here would be a duplicate config; the words it would add
    // would sit in the same list as typed symbols and be worth less than them.
    const state = stateWith(fallbackCompletion("/proj/src/a.ts", { on: true, claimed: true }));
    expect(await labelsIn(state)).toEqual([]);
    expect(canStartCompletion(state)).toBe(false);
  });
});

// The case the compartment exists for: a buffer opened while the language
// server was still starting is unclaimed, and has to give the words up in place
// when the server arrives, rather than at the next close and reopen.
describe("a buffer whose server arrives after it was opened", () => {
  const path = "/proj/src/a.ts";

  function opened(): { conf: Compartment; state: EditorState } {
    const conf = new Compartment();
    const state = stateWith([conf.of(fallbackCompletion(path, { on: true, claimed: false }))]);
    return { conf, state };
  }

  it("starts with words while nothing claims it", async () => {
    expect(await labelsIn(opened().state)).toContain("alpha");
  });

  it("drops them when the client comes up", async () => {
    const { conf, state } = opened();
    const relinked = state.update({
      effects: conf.reconfigure(fallbackCompletion(path, { on: true, claimed: true })),
    }).state;
    expect(await labelsIn(relinked)).toEqual([]);
    expect(canStartCompletion(relinked)).toBe(false);
  });

  it("takes them back if the server goes away again", async () => {
    // A project switch tears the client down before the replacement exists, and
    // a file left open across it should not end up with no completion at all.
    const { conf, state } = opened();
    const claimed = state.update({
      effects: conf.reconfigure(fallbackCompletion(path, { on: true, claimed: true })),
    }).state;
    const dropped = claimed.update({
      effects: conf.reconfigure(fallbackCompletion(path, { on: true, claimed: false })),
    }).state;
    expect(await labelsIn(dropped)).toContain("alpha");
  });
});
