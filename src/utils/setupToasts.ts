import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { emitWith, OPEN_IN_EDITOR, TOAST, type OpenInEditor, type ToastEvent } from "./events";
import { noteRun, seedRuns } from "./runStore";
import { noteTeardown } from "./teardowns";

/** Mirrors `Report` in src-tauri/src/setup.rs. */
export type SetupReport = {
  kind: "setup" | "run" | "teardown";
  worktree: string;
  state: "running" | "stopping" | "stopped" | "done" | "failed";
  code: number | null;
  log: string;
};

const folderName = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;

const WORD: Record<SetupReport["kind"], string> = { setup: "Setup", run: "Run", teardown: "Teardown" };

/** Toast a setup that has ended. A running one says nothing: the worktree
 *  appearing is already the news that it started. A teardown or a run speaks
 *  only when it failed: a worktree going away, or a run you stopped, is
 *  already the news. */
export function noteSetup(r: SetupReport): void {
  if (r.state === "running" || r.state === "stopping" || r.state === "stopped") return;
  if (r.kind !== "setup" && r.state !== "failed") return;
  const word = WORD[r.kind];
  const name = folderName(r.worktree);
  const showLog = { label: "Show log", run: () => emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: r.log }) };
  emitWith<ToastEvent>(
    TOAST,
    r.state === "done"
      ? { message: `Setup finished in ${name}`, kind: "info" }
      : {
          message:
            r.code === null
              ? `${word} in ${name} ended without an exit code`
              : `${word} in ${name} failed (exit ${r.code})`,
          kind: "error",
          action: showLog,
        },
  );
}

export async function watchSetup(): Promise<UnlistenFn> {
  const off = await listen<SetupReport>("setup://changed", (e) => {
    noteSetup(e.payload);
    noteTeardown(e.payload);
    noteRun(e.payload);
  });
  // After the listener, so a run that changes while the list is read is not missed.
  void seedRuns();
  return off;
}
