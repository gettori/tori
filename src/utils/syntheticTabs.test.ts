import { describe, it, expect } from "vite-plus/test";
import {
  isSyntheticId,
  syntheticId,
  parseSyntheticId,
  tabScopePath,
  parsePrArg,
  prAllTabId,
  prListTabId,
  prTabId,
  syntheticTabName,
  prDiffTabId,
  parsePrDiffArg,
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
    // One list per project, so it carries no argument and names itself.
    expect(syntheticTabName(prListTabId(WS))).toBe("Pull requests");
    // A tab is a few characters wide: a sha is cut where it stops being
    // readable, and a file's history is known by the file's own name.
    expect(syntheticTabName(syntheticId("commit", WS, "a1b2c3d4e5f6a7b8"))).toBe("Commit a1b2c3d");
    expect(syntheticTabName(syntheticId("history", WS, "src/panels/Editor/Editor.tsx"))).toBe("History: Editor.tsx");
    // A path with no folders above it still names itself.
    expect(syntheticTabName(syntheticId("history", WS, "README.md"))).toBe("History: README.md");
    // A Search Editor's arg is a sequence number, not its query, so the id alone
    // names nothing more; the strip takes the query from `searchTabTitle`.
    expect(syntheticTabName(syntheticId("search", WS, "3"))).toBe("Search");
  });

  it("tells two pull requests' copies of one file apart", () => {
    // The number is what distinguishes them, the same way a sha distinguishes
    // two commits touching one file. Without it, reviewing the same file in two
    // pull requests would be one tab holding two sets of draft comments.
    const a = prDiffTabId(WS, 42, "src/utils/forgeChip.ts");
    const b = prDiffTabId(WS, 43, "src/utils/forgeChip.ts");
    expect(a).not.toBe(b);
    expect(parsePrDiffArg(parseSyntheticId(a)!.arg)).toEqual({
      number: 42,
      file: "src/utils/forgeChip.ts",
    });
    // Two digits, not three: the token checker reads `#412` as a hex colour.
    expect(syntheticTabName(a)).toBe("forgeChip.ts (#42)");
    // A path with a colon in it still splits at the first one, which is the
    // number's, so the rest of the path survives intact.
    const odd = prDiffTabId(WS, 7, "src/a:b.ts");
    expect(parsePrDiffArg(parseSyntheticId(odd)!.arg).file).toBe("src/a:b.ts");
  });

  it("reads an unparseable pull request arg as no pull request", () => {
    // Number 0 matches nothing, so the tab draws its own "nothing here" rather
    // than another pull request's diff.
    expect(parsePrDiffArg("nonsense")).toEqual({ number: 0, file: "" });
    expect(parsePrDiffArg("notanumber:src/a.ts")).toEqual({ number: 0, file: "src/a.ts" });
    // The overview tab reads the same way, since its whole arg is the number.
    expect(parsePrArg("nonsense")).toBe(0);
    expect(syntheticTabName(prTabId(WS, 42))).toBe("#42");
  });

  it("names the stacked tab for what it holds, and the pull request it is from", () => {
    // Two labels that must not read as each other: the overview tab is the
    // pull request, this one is every file of it.
    expect(syntheticTabName(prAllTabId(WS, 42))).toBe("All files #42");
    expect(prAllTabId(WS, 42)).not.toBe(prTabId(WS, 42));
  });
});
