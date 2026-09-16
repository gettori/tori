import { describe, it, expect } from "vitest";
import { isScratchPath, defaultSaveName, resolveSavePath } from "./scratch";

const DIR = "/Users/me/.config/tori/scratch";

describe("telling a scratch from any other file", () => {
  it("recognises a file in the scratch directory", () => {
    expect(isScratchPath(`${DIR}/Untitled-1`, DIR)).toBe(true);
  });

  it("does not claim a sibling directory that starts the same way", () => {
    // The two rules reading this both delete something, so a prefix match on
    // the bare string would trash a file in `…/scratchpad/`.
    expect(isScratchPath("/Users/me/.config/tori/scratchpad/notes.md", DIR)).toBe(false);
  });

  it("does not claim the directory itself", () => {
    expect(isScratchPath(DIR, DIR)).toBe(false);
  });

  it("claims nothing at all when the directory is unknown", () => {
    // The backend has not answered yet, or could not. Answering false leaves
    // both delete paths declining, which is the direction that loses no work.
    expect(isScratchPath(`${DIR}/Untitled-1`, null)).toBe(false);
  });

  it("recognises a scratch nested below the directory", () => {
    expect(isScratchPath(`${DIR}/notes/Untitled-2`, DIR)).toBe(true);
  });
});

describe("what the Save-as prompt starts with", () => {
  it("offers the name the file already has", () => {
    expect(defaultSaveName(`${DIR}/Untitled-1`)).toBe("Untitled-1");
  });

  it("offers a real file's own name too", () => {
    expect(defaultSaveName("/space/proj/src/a.ts")).toBe("a.ts");
  });
});

describe("where a Save-as answer points", () => {
  const ROOT = "/space/proj/main";

  it("reads a bare name against the selected workspace", () => {
    expect(resolveSavePath("notes.md", ROOT)).toBe(`${ROOT}/notes.md`);
  });

  it("reads a relative path against it too", () => {
    expect(resolveSavePath("docs/notes.md", ROOT)).toBe(`${ROOT}/docs/notes.md`);
  });

  it("takes an absolute answer literally, workspace or not", () => {
    expect(resolveSavePath("/tmp/notes.md", ROOT)).toBe("/tmp/notes.md");
    expect(resolveSavePath("/tmp/notes.md", null)).toBe("/tmp/notes.md");
  });

  it("trims what was typed", () => {
    expect(resolveSavePath("  notes.md  ", ROOT)).toBe(`${ROOT}/notes.md`);
  });

  it("refuses a cancelled or empty prompt", () => {
    expect(resolveSavePath(null, ROOT)).toBeNull();
    expect(resolveSavePath("", ROOT)).toBeNull();
    expect(resolveSavePath("   ", ROOT)).toBeNull();
  });

  it("refuses a directory, which is a place to save into and not a file", () => {
    expect(resolveSavePath("src/", ROOT)).toBeNull();
  });

  it("refuses a bare name with no workspace to read it against", () => {
    // Rather than guessing at the home or scratch directory, which would put
    // the file somewhere nobody chose and then repoint the tab at it.
    expect(resolveSavePath("notes.md", null)).toBeNull();
  });
});
