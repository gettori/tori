import { describe, it, expect, beforeEach } from "vite-plus/test";

// The rules the tree's open directories follow with no tree mounted: what a
// stored shape is allowed to be, and what happens to an entry when the folder
// it names moves or goes. The mounted half is in `FileTree.test.tsx`.

import {
  collapseDirs,
  isDirOpen,
  isSectionOpen,
  mapExpandedPaths,
  nextSessionKey,
  parseExpandedStore,
  resetExpanded,
  setDirOpen,
  setSectionOpen,
  type ExpandedStore,
} from "./treeExpanded";

const WS = "topic:f1";
const A = "/feat/api";
const B = "/feat/web";

beforeEach(resetExpanded);

describe("parseExpandedStore", () => {
  it("reads a stored shape it does not recognise as nothing open", () => {
    expect(parseExpandedStore(null)).toEqual({});
    expect(parseExpandedStore("{oops")).toEqual({});
    expect(parseExpandedStore('["a"]')).toEqual({});
    expect(parseExpandedStore('{"ws":7}')).toEqual({});
  });

  it("keeps the paths and drops everything else in the list", () => {
    const out = parseExpandedStore(JSON.stringify({ [WS]: { dirs: [`${A}/src`, 3, "", null], closed: [B] } }));
    expect(out[WS]).toEqual({ dirs: [`${A}/src`], closed: [B] });
  });

  it("drops a workspace left holding nothing, which would outlive every entry in it", () => {
    expect(parseExpandedStore(JSON.stringify({ [WS]: { dirs: [], closed: [] } }))).toEqual({});
  });
});

describe("mapExpandedPaths", () => {
  const store: ExpandedStore = {
    [WS]: { dirs: [`${A}/src`, `${A}/src/utils`, `${B}/lib`], closed: [B] },
    "/w/other": { dirs: [`${A}/src`], closed: [] },
  };

  it("follows a renamed folder, in every workspace holding it", () => {
    const out = mapExpandedPaths(store, (p) => (p.startsWith(`${A}/src`) ? p.replace(`${A}/src`, `${A}/lib`) : p));
    expect(out[WS].dirs).toEqual([`${A}/lib`, `${A}/lib/utils`, `${B}/lib`]);
    expect(out["/w/other"].dirs).toEqual([`${A}/lib`]);
    // The section header travels the same way, so a member that moved is not
    // silently reopened.
    expect(out[WS].closed).toEqual([B]);
  });

  it("drops what is gone, and the workspace once nothing is left", () => {
    const out = mapExpandedPaths(store, (p) => (p.startsWith(A) ? null : p));
    expect(out[WS]).toEqual({ dirs: [`${B}/lib`], closed: [B] });
    expect(out).not.toHaveProperty("/w/other");
  });

  it("hands back the same store when nothing moved, so no reader re-runs", () => {
    expect(mapExpandedPaths(store, (p) => p)).toBe(store);
  });

  it("merges rather than duplicating when a rename lands on a folder already open", () => {
    const out = mapExpandedPaths({ [WS]: { dirs: [`${A}/src`, `${A}/lib`], closed: [] } }, (p) =>
      p === `${A}/src` ? `${A}/lib` : p,
    );
    expect(out[WS].dirs).toEqual([`${A}/lib`]);
  });
});

describe("the live store", () => {
  it("opens and closes a directory, and says so per workspace", () => {
    setDirOpen(WS, `${A}/src`, true);
    expect(isDirOpen(WS, `${A}/src`)).toBe(true);
    expect(isDirOpen("/w/other", `${A}/src`)).toBe(false);

    setDirOpen(WS, `${A}/src`, false);
    expect(isDirOpen(WS, `${A}/src`)).toBe(false);
  });

  it("starts a section open and a directory shut", () => {
    expect(isSectionOpen(WS, B)).toBe(true);
    expect(isDirOpen(WS, `${B}/src`)).toBe(false);

    setSectionOpen(WS, B, false);
    expect(isSectionOpen(WS, B)).toBe(false);
  });

  it("leaves the section headers alone when the folders are collapsed", () => {
    setDirOpen(WS, `${A}/src`, true);
    setSectionOpen(WS, B, false);

    collapseDirs(WS);

    expect(isDirOpen(WS, `${A}/src`)).toBe(false);
    expect(isSectionOpen(WS, B)).toBe(false);
  });

  it("hands out a fresh session key each time, so two unkeyed panes never share one", () => {
    expect(nextSessionKey()).not.toBe(nextSessionKey());
  });
});
