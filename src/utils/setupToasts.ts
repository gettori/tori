import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { emitWith, OPEN_IN_EDITOR, TOAST, type OpenInEditor, type ToastEvent } from "./events";

/** Mirrors `Report` in src-tauri/src/setup.rs. */
export type SetupReport = {
  worktree: string;
  state: "running" | "done" | "failed";
  code: number | null;
  log: string;
};

const folderName = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;

/** Toast a setup that has ended. A running one says nothing: the worktree
 *  appearing is already the news that it started. */
export function noteSetup(r: SetupReport): void {
  if (r.state === "running") return;
  const name = folderName(r.worktree);
  const showLog = { label: "Show log", run: () => emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: r.log }) };
  emitWith<ToastEvent>(
    TOAST,
    r.state === "done"
      ? { message: `Setup finished in ${name}`, kind: "info" }
      : {
          message:
            r.code === null
              ? `Setup in ${name} ended without an exit code`
              : `Setup in ${name} failed (exit ${r.code})`,
          kind: "error",
          action: showLog,
        },
  );
}

export function watchSetup(): Promise<UnlistenFn> {
  return listen<SetupReport>("setup://changed", (e) => noteSetup(e.payload));
}
