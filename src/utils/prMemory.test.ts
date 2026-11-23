import { describe, it, expect, beforeEach, vi } from "vite-plus/test";
import type { UnitStatus } from "./forgeTypes";

const REPO = "/root/work/tori";
const WT = "/root/work/tori-wt/side-panel";

function status(branch: string, number: number | null, state: "open" | "merged" = "open"): UnitStatus {
  return {
    headRef: branch,
    pullRequest:
      number === null
        ? null
        : ({
            number,
            title: `PR ${number}`,
            state,
            url: `https://example.test/pull/${number}`,
          } as UnitStatus["pullRequest"]),
    checks: { state: "none", total: 0, failing: 0, skipped: 0, contexts: [] },
    reviewDecision: "none",
    reviews: [],
    requestedReviewers: [],
    viewerReview: null,
  };
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  vi.resetModules();
});

describe("the remembered pull requests", () => {
  it("keeps the last pull request per branch and forgets one the forge says is gone", async () => {
    const { flush } = await import("solid-js");
    const { rememberPrs, rememberedPr } = await import("./prMemory");
    rememberPrs(REPO, { "side-panel": status("side-panel", 214), main: status("main", 9, "merged") }, 1);
    flush();
    expect(rememberedPr(REPO, "side-panel")).toEqual({
      number: 214,
      title: "PR 214",
      state: "open",
      url: "https://example.test/pull/214",
      changedAt: 1,
    });
    rememberPrs(REPO, { main: status("main", null) }, 2);
    flush();
    expect(rememberedPr(REPO, "main")).toBeNull();
    expect(rememberedPr(REPO, "side-panel")?.changedAt).toBe(1);
  });

  it("finds a worktree by its pull request number after a restart, drawn muted", async () => {
    const first = await import("./prMemory");
    first.rememberPrs(REPO, { "side-panel": status("side-panel", 214) });

    vi.resetModules();
    const { flush } = await import("solid-js");
    const { livePlaces, noteNavTree, placeNumbers } = await import("./navIndex");
    const { rank } = await import("./navRank");
    noteNavTree(
      [
        {
          name: "Labs",
          projects: [
            {
              name: "tori",
              path: REPO,
              branchUnits: [{ folderPath: WT, branch: "side-panel", label: "side-panel", kind: "worktree" }],
            },
          ],
        },
      ],
      { [REPO]: "git@github.com:gettori/tori.git" },
    );
    flush();
    const top = rank(livePlaces(), "214", (p) => ({
      fields: [{ slot: "title", text: p.title }],
      numbers: placeNumbers(p),
    }))[0];
    expect(top.item).toMatchObject({
      id: `unit:${WT} side-panel`,
      pr: { number: 214, tone: "closed", remembered: true },
    });
    expect(top.marks).toEqual({ pr: [{ start: 1, end: 4 }] });
  });
});
