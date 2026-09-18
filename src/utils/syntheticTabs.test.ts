import { describe, it, expect } from "vitest";
import {
  isSyntheticId,
  syntheticId,
  parseSyntheticId,
  tabScopePath,
  syntheticTabName,
} from "./syntheticTabs";

const WS = "/Users/me/Projects/app/wave-2";

describe("synthetic tab ids", () => {
  it("tells a view apart from a file", () => {
    expect(isSyntheticId(syntheticId("graph", WS))).toBe(true);
    expect(isSyntheticId(`${WS}/src/a.ts`)).toBe(false);
    // A file that merely mentions the scheme is still a file.
    expect(isSyntheticId(`${WS}/tori://graph`)).toBe(false);
  });

  it("round-trips the kind, the argument and the workspace", () => {
    expect(parseSyntheticId(syntheticId("graph", WS))).toEqual({ kind: "graph", arg: "", workspace: WS });
    expect(parseSyntheticId(syntheticId("commit", WS, "a1b2c3"))).toEqual({
      kind: "commit",
      arg: "a1b2c3",
      workspace: WS,
    });
  });

  it("survives an argument that looks like another field", () => {
    const id = syntheticId("history", WS, "src/a?ws=/elsewhere.ts");
    expect(parseSyntheticId(id)).toEqual({
      kind: "history",
      arg: "src/a?ws=/elsewhere.ts",
      workspace: WS,
    });
  });

  it("refuses anything that is not one of ours", () => {
    expect(parseSyntheticId(`${WS}/src/a.ts`)).toBeNull();
    expect(parseSyntheticId("tori://graph")).toBeNull();
    expect(parseSyntheticId("tori://?ws=/x")).toBeNull();
    expect(parseSyntheticId("tori://graph?ws=")).toBeNull();
    // A malformed escape is unparseable, not a throw.
    expect(parseSyntheticId("tori://graph?ws=%")).toBeNull();
  });

  it("scopes a view to its workspace and a file to itself", () => {
    expect(tabScopePath(syntheticId("graph", WS))).toBe(WS);
    expect(tabScopePath(`${WS}/src/a.ts`)).toBe(`${WS}/src/a.ts`);
    // Unparseable: scoped to nothing, so a folder sweep leaves it alone.
    expect(tabScopePath("tori://graph")).toBe("tori://graph");
  });

  it("names a view for the tab strip", () => {
    expect(syntheticTabName(syntheticId("graph", WS))).toBe("Graph");
    // A tab is a few characters wide: a sha is cut where it stops being
    // readable, and a file's history is known by the file's own name.
    expect(syntheticTabName(syntheticId("commit", WS, "a1b2c3d4e5f6a7b8"))).toBe("Commit a1b2c3d");
    expect(syntheticTabName(syntheticId("history", WS, "src/panels/Editor/Editor.tsx"))).toBe(
      "History: Editor.tsx",
    );
    // A path with no folders above it still names itself.
    expect(syntheticTabName(syntheticId("history", WS, "README.md"))).toBe("History: README.md");
    // A Search Editor's arg is a sequence number, not its query, so the id alone
    // names nothing more; the strip takes the query from `searchTabTitle`.
    expect(syntheticTabName(syntheticId("search", WS, "3"))).toBe("Search");
  });
});
