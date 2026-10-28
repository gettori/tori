// Each worktree's live run command, from `run_list` once and `setup://changed`
// after, so a webview reload still sees the servers Rust kept running.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { emitWith, TOAST, type ToastEvent } from "./events";
import type { SetupReport } from "./setupToasts";

const [runs, setRuns] = createSignal<Readonly<Record<string, SetupReport>>>({});

const live = (r: SetupReport) => r.state === "running" || r.state === "stopping";

export function noteRun(r: SetupReport): void {
  if (r.kind !== "run") return;
  setRuns((prev) => {
    const next = { ...prev };
    if (live(r)) next[r.worktree] = r;
    else delete next[r.worktree];
    return next;
  });
}

export async function seedRuns(): Promise<void> {
  try {
    const list = await invoke<SetupReport[]>("run_list");
    // An event that landed while the list was read is newer than it.
    setRuns((prev) => {
      const next = { ...prev };
      for (const r of list ?? []) if (!(r.worktree in next)) next[r.worktree] = r;
      return next;
    });
  } catch (e) {
    console.warn("run_list failed", e);
  }
}

export const runAt = (worktree: string): SetupReport | null => runs()[worktree] ?? null;

const [allowed, setAllowed] = createSignal<Readonly<Record<string, boolean>>>({});
const asked = new Set<string>();

/** Whether Rust would let this worktree run its command. False until Rust has
 *  answered, so a fork's row never shows a button only to refuse it. */
export function runnable(worktree: string): boolean {
  if (!asked.has(worktree)) {
    asked.add(worktree);
    invoke<boolean>("worktree_not_a_fork", { worktreePath: worktree })
      .then((ok) => setAllowed((prev) => ({ ...prev, [worktree]: ok })))
      .catch(() => asked.delete(worktree));
  }
  return allowed()[worktree] === true;
}

export type RepoRun = { project: string; command: string };

const [repoRuns, setRepoRuns] = createSignal<Readonly<Record<string, RepoRun | null>>>({});
const repoAsked = new Set<string>();
let repoListening = false;

/** The run command this worktree's accepted proposal gives it, null until Rust
 *  has answered or when there is none. Asked again after any accept or decline. */
export function repoRunAt(worktree: string): RepoRun | null {
  if (!repoListening) {
    repoListening = true;
    void listen("proposals://changed", () => {
      repoAsked.clear();
      setRepoRuns({});
    }).catch((e) => console.warn("run: no proposal events, a repo run command shows after a reload", e));
  }
  if (!repoAsked.has(worktree)) {
    repoAsked.add(worktree);
    invoke<RepoRun | null>("repo_run_at", { worktreePath: worktree })
      .then((run) => setRepoRuns((prev) => ({ ...prev, [worktree]: run })))
      .catch(() => repoAsked.delete(worktree));
  }
  return repoRuns()[worktree] ?? null;
}

function toastError(e: unknown) {
  emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
}

export function startRun(project: string, worktree: string): void {
  invoke<SetupReport>("run_start", { projectPath: project, worktreePath: worktree }).then(noteRun).catch(toastError);
}

export function stopRun(worktree: string): void {
  invoke("run_stop", { worktreePath: worktree }).catch(toastError);
}
