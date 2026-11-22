import { createLiveSignal } from "../lib/liveState";

import type { SetupReport } from "./setupToasts";

const [live, setLive] = createLiveSignal<ReadonlySet<string>>(new Set());

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
