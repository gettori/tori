import { describe, expect, it } from "vite-plus/test";
import type { PrStack } from "../../utils/forgeTypes";
import { groupAttempts } from "./attempts";
import { groupStacks, type StackEntry } from "./stacks";

type Unit = { label: string; folderPath: string; stack: PrStack | null };

const unit = (label: string, stack: [number, number, number] | null = null): Unit => ({
  label,
  folderPath: `/repo/${label}`,
  stack: stack ? { number: stack[0], position: stack[1], size: stack[2], baseRef: "main" } : null,
});
const shape = (entries: StackEntry<Unit>[]) =>
  entries.map((e) => (e.kind === "unit" ? e.unit.label : e.members.map((m) => m.label)));
const group = (units: Unit[]) => groupStacks(units, (u) => u.stack);

describe("groupStacks", () => {
  it("gathers a stack's layers top first, in the place its top layer had", () => {
    const units = [
      unit("main"),
      unit("auth", [5, 1, 3]),
      unit("chore"),
      unit("ui", [5, 3, 3]),
      unit("api", [5, 2, 3]),
      unit("spike"),
    ];
    expect(shape(group(units))).toEqual(["main", "chore", ["ui", "api", "auth"], "spike"]);
  });

  it("leaves a lone layer flat", () => {
    const units = [unit("main"), unit("api", [5, 2, 3])];
    expect(shape(group(units))).toEqual(["main", "api"]);
  });

  it("keeps two stacks in one project apart", () => {
    const units = [unit("a1", [5, 1, 2]), unit("b1", [9, 1, 2]), unit("a2", [5, 2, 2]), unit("b2", [9, 2, 2])];
    expect(shape(group(units))).toEqual([
      ["a2", "a1"],
      ["b2", "b1"],
    ]);
  });

  it("lets an attempt stay in its fan-out group even when it is also a layer", () => {
    const units = [unit("a1", [5, 1, 3]), unit("a2", [5, 2, 3]), unit("try-1", [5, 3, 3])];
    const split = groupAttempts(units, [{ path: "/repo/try-1", groupId: "g", goal: "faster" }]);
    expect(shape(group(split.units))).toEqual([["a2", "a1"]]);
    expect(split.groups[0].members[0].unit?.label).toBe("try-1");
  });
});
