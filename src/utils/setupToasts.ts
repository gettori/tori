import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { emitWith, OPEN_IN_EDITOR, TOAST, type OpenInEditor, type ToastEvent } from "./events";
import { noteTeardown } from "./teardowns";

/** Mirrors `Report` in src-tauri/src/setup.rs. */
export type SetupReport = {
  kind: "setup" | "teardown";
  worktree: string;
  state: "running" | "done" | "failed";
  code: number | null;
  log: string;
};

const folderName = (p: string) => p.slice(p.lastIndexOf("/") + 1) || p;

/** Toast a setup that has ended. A running one says nothing: the worktree
 *  appearing is already the news that it started. A teardown speaks only when
 *  it failed, since the worktree going away is the news that it finished. */
export function noteSetup(r: SetupReport): void {
  if (r.state === "running") return;
  if (r.kind === "teardown" && r.state !== "failed") return;
  const word = r.kind === "teardown" ? "Teardown" : "Setup";
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

export function watchSetup(): Promise<UnlistenFn> {
  return listen<SetupReport>("setup://changed", (e) => {
    noteSetup(e.payload);
    noteTeardown(e.payload);
  });
}
