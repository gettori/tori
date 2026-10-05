// The derivation layer is memoized under the shell's root (native-speed plan
// phase 3): one placement change rebuilds a workspace's pane maps once, and
// every consumer reads that one answer, instead of each paneTabs call filtering
// the whole tab union per pane (O(tabs x panes) per click).
import { describe, it, expect, beforeEach } from "vite-plus/test";
import { createRoot } from "solid-js";
import {
  __placementComputesForTests,
  installPaneTabsMemo,
  paneActiveId,
  paneTabs,
} from "./paneTabs";
import { installUnifiedTabsMemo, unifiedTabs } from "./unifiedTabs";
import { ensureEnvelope, layoutRoot, resetPaneLayoutModel, seedTwoPane } from "../layout/layoutStore";
import { moveTabToPane, resetTabPlacement, setPaneActive } from "../layout/tabPlacement";
import { leaves } from "../layout/paneLayout";
import { open, setOpen, type OpenTerm } from "../panels/Terminal/terminalTabStore";

const WS = "/root/work/repo";

const shell = (n: number): OpenTerm => ({
  id: `sh:${n}`,
  title: `sh:${n}`,
  cwd: WS,
  workspace: WS,
  kind: "shell",
  program: "zsh",
  args: [],
  profile: null,
});

beforeEach(() => {
  localStorage.clear();
  resetPaneLayoutModel();
  resetTabPlacement();
  setOpen([]);
});

describe("the placement memo", () => {
  it("rebuilds once per change however many consumers read, and keeps the maps right", () => {
    createRoot((dispose) => {
      installUnifiedTabsMemo();
      installPaneTabsMemo();
      ensureEnvelope(WS, () => seedTwoPane({ rightShare: 50, showLeft: true, showRight: true }));
      const root = layoutRoot(WS)!;
      const [left, right] = leaves(root).map((l) => l.id);
      setOpen(Array.from({ length: 12 }, (_, i) => shell(i)));
      const tabsInWs = open().map((t) => ({ id: t.id, kind: t.kind }));
      for (const n of [8, 9, 10, 11]) {
        expect(moveTabToPane({ ws: WS, tab: { id: `sh:${n}`, kind: "shell" }, targetPaneId: right, root, tabsInWs })).toBeNull();
      }

      // Warm the memo, then read repeatedly: cached, no recompute, same array.
      paneTabs(WS, left);
      const before = __placementComputesForTests();
      const a = paneTabs(WS, left);
      const b = paneTabs(WS, left);
      paneTabs(WS, right);
      paneActiveId(WS, left);
      expect(a).toBe(b);
      expect(unifiedTabs()).toBe(unifiedTabs());
      expect(__placementComputesForTests()).toBe(before);

      // One click (a pane's active pick changes), many reads: one rebuild.
      setPaneActive(WS, left, "sh:3");
      paneTabs(WS, left);
      paneTabs(WS, right);
      paneActiveId(WS, left);
      paneActiveId(WS, right);
      expect(__placementComputesForTests()).toBe(before + 1);

      // And the maps say what the per-call filters used to say.
      expect(paneTabs(WS, right).map((t) => t.id)).toEqual(["sh:8", "sh:9", "sh:10", "sh:11"]);
      expect(paneTabs(WS, left).map((t) => t.id)).toEqual(
        Array.from({ length: 8 }, (_, i) => `sh:${i}`),
      );
      expect(paneActiveId(WS, left)).toBe("sh:3");
      dispose();
    });
  });

  it("falls back to per-call derivation when nothing installed a memo", () => {
    ensureEnvelope(WS, () => seedTwoPane({ rightShare: 50, showLeft: true, showRight: true }));
    const root = layoutRoot(WS)!;
    const [left] = leaves(root).map((l) => l.id);
    setOpen([shell(1), shell(2)]);
    const before = __placementComputesForTests();
    expect(paneTabs(WS, left).map((t) => t.id)).toEqual(["sh:1", "sh:2"]);
    expect(__placementComputesForTests()).toBe(before + 1);
  });
});
