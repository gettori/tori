// The dock's one pane exists before anything opens in it, so a command started
// from any workspace has a pane to land in. It takes both kinds that live there:
// what Tori runs, and the shells you open yourself.
import { describe, it, expect, beforeEach } from "vitest";
import { ensureShellsWorkspace, shellsPane } from "./shellsWorkspace";
import { layoutRoot, resetPaneLayoutModel } from "./layoutStore";
import { leaves } from "./paneLayout";
import { paneLock, placementRefusal, resetTabPlacement, setPaneLock } from "./tabPlacement";
import { SHELLS_KEY } from "../utils/features";

beforeEach(() => {
  localStorage.clear();
  resetPaneLayoutModel();
  resetTabPlacement();
});

describe("the Shells workspace", () => {
  it("is one pane that takes both a command and a shell you opened", () => {
    expect(layoutRoot(SHELLS_KEY)).toBeNull();
    ensureShellsWorkspace();
    const root = layoutRoot(SHELLS_KEY)!;
    expect(root).toBeTruthy();
    expect(leaves(root)).toHaveLength(1);

    const refusal = (kind: string) =>
      placementRefusal({
        ws: SHELLS_KEY,
        tab: { id: `t:${kind}`, kind },
        targetPaneId: shellsPane()!,
        root,
        tabsInWs: [],
      });
    expect(refusal("command")).toBeNull();
    expect(refusal("shell")).toBeNull();
  });

  // The build before the dock's `+` persisted a `command` lock, so the seed has
  // to clear it rather than merely stop writing it.
  it("clears a command lock left behind by an earlier version", () => {
    ensureShellsWorkspace();
    setPaneLock(SHELLS_KEY, shellsPane()!, "command");
    ensureShellsWorkspace();
    expect(paneLock(SHELLS_KEY, shellsPane()!)).toBeNull();
  });

  it("is idempotent across launches", () => {
    ensureShellsWorkspace();
    const root = layoutRoot(SHELLS_KEY);
    ensureShellsWorkspace();
    expect(layoutRoot(SHELLS_KEY)).toBe(root);
  });
});
