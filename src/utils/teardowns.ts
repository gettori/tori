import { createSignal } from "solid-js";

import type { SetupReport } from "./setupToasts";

const [live, setLive] = createSignal<ReadonlySet<string>>(new Set());

export function noteTeardown(r: SetupReport): void {
  if (r.kind !== "teardown") return;
  setLive((prev) => {
    const next = new Set(prev);
    if (r.state === "running") next.add(r.worktree);
    else next.delete(r.worktree);
    return next;
  });
}

export const tearingDown = (worktree: string): boolean => live().has(worktree);
