import { describe, it, expect } from "vitest";
import { Compartment, EditorState, type StateEffect } from "@codemirror/state";
import { reattachLsp, reconfigureBuffers, type LspBuffer } from "./lspReattach";

// `tabSize` stands in for the LSP plugin: it is a real facet living in a real
// compartment, so "the configuration changed" is asserted against CM6 itself
// rather than against a stub of it. What matters is the split, a background
// buffer belongs to no view and must still end up reconfigured.
const TAB_BEFORE = 2;
const TAB_AFTER = 8;

function buffer(): LspBuffer {
  const lsp = new Compartment();
  return {
    lsp,
    state: EditorState.create({ extensions: [lsp.of(EditorState.tabSize.of(TAB_BEFORE))] }),
  };
}

describe("reattachLsp", () => {
  it("reconfigures a background buffer in place, with no view involved", () => {
    const buf = buffer();
    let dispatched = 0;
    reattachLsp([["/a.ts", buf]], null, () => EditorState.tabSize.of(TAB_AFTER), () => (dispatched += 1));
    expect(buf.state.tabSize).toBe(TAB_AFTER);
    expect(dispatched).toBe(0);
  });

  it("routes the shown buffer through dispatch and leaves its stashed state alone", () => {
    const buf = buffer();
    const effects: StateEffect<unknown>[] = [];
    reattachLsp([["/a.ts", buf]], "/a.ts", () => EditorState.tabSize.of(TAB_AFTER), (e) => effects.push(e));
    expect(effects).toHaveLength(1);
    // The view owns the shown buffer's truth; writing the stash here would
    // clobber whatever the user has typed since the last swap.
    expect(buf.state.tabSize).toBe(TAB_BEFORE);
  });

  it("covers every buffer, shown and background, in one pass", () => {
    const shown = buffer();
    const bgOne = buffer();
    const bgTwo = buffer();
    let dispatched = 0;
    reattachLsp(
      [
        ["/shown.ts", shown],
        ["/one.ts", bgOne],
        ["/two.ts", bgTwo],
      ],
      "/shown.ts",
      () => EditorState.tabSize.of(TAB_AFTER),
      () => (dispatched += 1),
    );
    expect(dispatched).toBe(1);
    expect(bgOne.state.tabSize).toBe(TAB_AFTER);
    expect(bgTwo.state.tabSize).toBe(TAB_AFTER);
  });

  it("resolves per path, so each buffer gets its own answer", () => {
    const ts = buffer();
    const md = buffer();
    reattachLsp(
      [
        ["/a.ts", ts],
        ["/b.md", md],
      ],
      null,
      (path) => (path.endsWith(".ts") ? EditorState.tabSize.of(TAB_AFTER) : []),
      () => {},
    );
    expect(ts.state.tabSize).toBe(TAB_AFTER);
    // An empty extension means the compartment now contributes nothing, so the
    // facet falls back to its default rather than keeping the stale value.
    expect(md.state.tabSize).toBe(4);
  });
});

// A buffer has more than one compartment that moves when the client does: the
// plugin, and the fallback completion that exists only while no server claims
// the file. `pick` is what keeps them independent, so a settings change can
// reach one without closing and reopening the document on the server.
describe("reconfigureBuffers", () => {
  it("reaches the named compartment and leaves its sibling alone", () => {
    const lsp = new Compartment();
    const completion = new Compartment();
    const buf = {
      lsp,
      completion,
      state: EditorState.create({
        extensions: [lsp.of(EditorState.tabSize.of(TAB_BEFORE)), completion.of([])],
      }),
    };

    reconfigureBuffers(
      [["/a.md", buf]],
      null,
      (b) => b.completion,
      () => EditorState.readOnly.of(true),
      () => {},
    );

    expect(buf.state.readOnly).toBe(true);
    expect(buf.state.tabSize).toBe(TAB_BEFORE);
  });
});
