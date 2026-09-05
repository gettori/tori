// The Shells workspace's one pane admits command tabs and nothing else, and it
// exists before anything selects it, so a command tab opened from another
// workspace has a pane to land in.
import { describe, it, expect, beforeEach } from "vitest";
import { ensureShellsWorkspace, shellsPane } from "./shellsWorkspace";
import { layoutRoot, resetPaneLayoutModel } from "./layoutStore";
import { placementRefusal, resetTabPlacement } from "./tabPlacement";
import { SHELLS_KEY } from "../utils/features";

beforeEach(() => {
  localStorage.clear();
  resetPaneLayoutModel();
  resetTabPlacement();
});

describe("the Shells workspace", () => {
  it("is one pane that takes command tabs and refuses every other kind", () => {
    expect(layoutRoot(SHELLS_KEY)).toBeNull();
    ensureShellsWorkspace();
    const root = layoutRoot(SHELLS_KEY)!;
    expect(root).toBeTruthy();

    const refusal = (kind: string) =>
      placementRefusal({
        ws: SHELLS_KEY,
        tab: { id: `t:${kind}`, kind },
        targetPaneId: shellsPane()!,
        root,
        tabsInWs: [],
      });
    // The lock is compared against `tab.kind` exactly, so it is the tab kind
    // that has to be `command`, not merely a terminal.
    expect(refusal("command")).toBeNull();
    expect(refusal("file")).toBe("That pane only takes command tabs.");
    expect(refusal("shell")).toBe("That pane only takes command tabs.");
  });

  it("is idempotent across launches", () => {
    ensureShellsWorkspace();
    const root = layoutRoot(SHELLS_KEY);
    ensureShellsWorkspace();
    expect(layoutRoot(SHELLS_KEY)).toBe(root);
  });
});
