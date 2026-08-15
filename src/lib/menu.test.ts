import { describe, it, expect } from "vitest";
import { ContextMenu, DropdownMenu } from "./menu";

// Kobalte builds both menus on one shared `Menu` implementation, and
// `src/components/Menu/rows.tsx` depends on that: the row layer names
// `DropdownMenu.Item` and `DropdownMenu.Separator` and is rendered inside either
// root, which only works because the two entry points re-export the *same*
// components rather than two parallel families.
//
// That is an implementation detail of a dependency, not a documented contract,
// so it is asserted rather than assumed. A Kobalte release that gives the two
// menus their own items fails here, naming the file that would otherwise fail
// with a missing-context error at some call site months later.
describe("the two menu primitives", () => {
  it("share every part the row layer is built from", () => {
    for (const part of ["Item", "Separator", "Portal", "Sub", "SubTrigger", "SubContent"] as const) {
      expect(ContextMenu[part], part).toBe(DropdownMenu[part]);
    }
  });

  it("keep their own root, trigger and content, which is why there are two wrappers", () => {
    // The asymmetry the whole ticket turns on: a context menu's root omits
    // `open` and `getAnchorRect`, so it cannot be driven from state, and its
    // trigger places the menu at the cursor itself.
    expect(ContextMenu.Root).not.toBe(DropdownMenu.Root);
    expect(ContextMenu.Trigger).not.toBe(DropdownMenu.Trigger);
    expect(ContextMenu.Content).not.toBe(DropdownMenu.Content);
  });
});
