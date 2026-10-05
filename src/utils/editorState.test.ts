import { describe, it, expect, beforeEach } from "vite-plus/test";
import { editorState, publishEditorState, clearEditorState } from "./editorState";

// The whole point of the module: a consumer reads what the editor is showing
// without mounting the editor, which in jsdom would mean standing up CodeMirror.

beforeEach(() => clearEditorState());

describe("published editor state", () => {
  it("reads as empty before the editor says anything", () => {
    expect(editorState()).toEqual({
      activePath: null,
      dirty: false,
      tabCount: 0,
      projectRoot: null,
      recentJumps: [],
    });
  });

  it("hands a consumer the active file and its dirty flag", () => {
    publishEditorState({ activePath: "/proj/src/a.ts", dirty: true, tabCount: 2, projectRoot: "/proj", recentJumps: [] });
    expect(editorState().activePath).toBe("/proj/src/a.ts");
    expect(editorState().dirty).toBe(true);
    expect(editorState().tabCount).toBe(2);
    expect(editorState().projectRoot).toBe("/proj");
  });

  it("replaces the snapshot rather than merging into it", () => {
    // Half-updating is the failure this shape exists to prevent: an active path
    // from one moment beside a dirty flag from another would have the palette
    // offering to save a file that is already saved.
    publishEditorState({ activePath: "/proj/src/a.ts", dirty: true, tabCount: 1, projectRoot: "/proj", recentJumps: [] });
    publishEditorState({ activePath: null, dirty: false, tabCount: 0, projectRoot: "/proj", recentJumps: [] });
    expect(editorState()).toEqual({ activePath: null, dirty: false, tabCount: 0, projectRoot: "/proj", recentJumps: [] });
  });
});
