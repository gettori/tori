// The dock's one pane exists before anything opens in it, so a command started
// from any workspace has a pane to land in, and it takes command tabs only.
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
  it("is one pane that takes a command and nothing else", () => {
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
    expect(refusal("shell")).not.toBeNull();
  });

  // The Shells-mode build cleared the lock so its `+` could open a shell here,
  // and that open pane is persisted. The seed has to put the lock back.
  it("locks a pane an earlier version left open to any kind", () => {
    ensureShellsWorkspace();
    setPaneLock(SHELLS_KEY, shellsPane()!, null);
    ensureShellsWorkspace();
    expect(paneLock(SHELLS_KEY, shellsPane()!)).toBe("command");
  });

  it("is idempotent across launches", () => {
    ensureShellsWorkspace();
    const root = layoutRoot(SHELLS_KEY);
    ensureShellsWorkspace();
    expect(layoutRoot(SHELLS_KEY)).toBe(root);
  });
});
