import type { RootScan } from "./grouping";

export const MIXED: RootScan = {
  base: "/u/P",
  folders: [
    { name: "office", entries: ["x"] },
    { name: "screenshots", entries: ["2026"] },
    { name: "work", entries: ["api", "app"] },
  ],
  hidden: [],
  spaces: [{ name: "work", path: "/u/P/work", projects: 2 }],
  misplaced: [
    {
      path: "/u/P/office/x/repo",
      relative: "office/x/repo",
      name: "repo",
      layout: { kind: "clone" },
      suggestion: "office",
    },
    { path: "/u/P/site", relative: "site", name: "site", layout: { kind: "clone" }, suggestion: "fonngroup" },
    { path: "/u/P/scratch", relative: "scratch", name: "scratch", layout: { kind: "plain" }, suggestion: null },
  ],
  emptyTop: ["screenshots"],
  tooBig: ["photos"],
  tooDeep: ["a/b/c/d/repo"],
  unreadable: [],
};
