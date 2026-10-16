// GitHub owns membership and order (`PrStack` on each pull request), so nothing
// here guesses from base branches.

import type { PrStack } from "../../utils/forgeTypes";

export type StackEntry<U> = { kind: "unit"; unit: U } | { kind: "stack"; stack: PrStack; members: U[] };

// A group takes the place its top layer had in `units`, so grouping moves
// nothing that is not a layer. A lone local layer stays flat: its own `n/size`
// mark already says it has neighbours.
export function groupStacks<U>(units: readonly U[], stackOf: (u: U) => PrStack | null): StackEntry<U>[] {
  const layers = new Map<number, { stack: PrStack; unit: U }[]>();
  for (const unit of units) {
    const stack = stackOf(unit);
    if (stack) layers.set(stack.number, [...(layers.get(stack.number) ?? []), { stack, unit }]);
  }
  const groups = new Map<number, Extract<StackEntry<U>, { kind: "stack" }>>();
  for (const [number, ls] of layers) {
    if (ls.length < 2) continue;
    const sorted = [...ls].sort((a, b) => b.stack.position - a.stack.position);
    groups.set(number, { kind: "stack", stack: sorted[0].stack, members: sorted.map((l) => l.unit) });
  }

  const out: StackEntry<U>[] = [];
  for (const unit of units) {
    const group = groups.get(stackOf(unit)?.number ?? Number.NaN);
    if (!group) out.push({ kind: "unit", unit });
    else if (group.members[0] === unit) out.push(group);
  }
  return out;
}
