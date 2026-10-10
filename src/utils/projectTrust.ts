// Project trust as the frontend sees it. The backend holds the answer and
// enforces it (`src-tauri/src/trust.rs`); this module asks the user and tells
// whoever started servers, without importing the editor, so Settings can too.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { emitWith, TOAST, type ToastEvent } from "./events";
import { isUnderPath } from "./pathScope";

/** Mirrors `trust::UNTRUSTED`, what `lsp_start`, `dap_start` and
 *  `format_document` refuse an untrusted project with. */
export const UNTRUSTED = "untrusted";

/** `path` is the trusted scope, which can sit above the project a start was
 *  asked under: trusting a worktree trusts the whole project. */
export type TrustChange = { path: string; trusted: boolean };

const [refused, setRefused] = createSignal<string[]>([]);
/** Projects a server was refused in this session, still untrusted. */
export { refused as refusedProjects };

// Asked once per project per session: a prompt on every file opened would nag,
// and Settings offers the same answer for as long as the project stays refused.
const asked: string[] = [];

let listeners: ((change: TrustChange) => void)[] = [];

/** Hear about trust being granted or revoked. Returns an unsubscribe. */
export function onTrustChange(cb: (change: TrustChange) => void): () => void {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}

function fire(change: TrustChange) {
  for (const l of [...listeners]) l(change);
}

/** Record a refused start. True when this project has not been asked about yet. */
export function noteRefused(projectPath: string): boolean {
  if (!refused().includes(projectPath)) setRefused([...refused(), projectPath]);
  if (asked.some((a) => isUnderPath(projectPath, a))) return false;
  asked.push(projectPath);
  return true;
}

/** Offer to trust the project `projectPath` belongs to. `message` says what
 *  stays off until then. */
export function askToTrust(projectPath: string, message: string): void {
  emitWith<ToastEvent>(TOAST, {
    kind: "info",
    message,
    action: {
      label: "Trust",
      run: () =>
        void trustProject(projectPath).catch((e) =>
          emitWith<ToastEvent>(TOAST, { message: `Could not trust this project: ${String(e)}` }),
        ),
    },
  });
}

/** Trust the project `projectPath` belongs to. */
export async function trustProject(projectPath: string): Promise<void> {
  const path = await invoke<string>("trust_project", { path: projectPath });
  setRefused(refused().filter((p) => !isUnderPath(p, path)));
  fire({ path, trusted: true });
}

/** Stop trusting a project, by the path `trusted_projects` listed it under. */
export async function revokeProject(path: string): Promise<void> {
  await invoke("revoke_project", { path });
  // What the revoke refuses next is the user's own doing, not a question.
  asked.push(path);
  fire({ path, trusted: false });
}

// One read of the trusted list for every surface that marks an untrusted
// project, refreshed on each change made here. Null until the first read lands,
// so nothing is marked while the answer is unknown.
const [trustedList, setTrustedList] = createSignal<string[] | null>(null);
let watching = false;

function watchTrusted() {
  if (watching) return;
  watching = true;
  const read = () =>
    void invoke<string[]>("trusted_projects")
      .then(setTrustedList)
      .catch(() => {});
  onTrustChange(read);
  read();
}

/** Whether the project at `path` is known to be untrusted. False while the list
 *  is still loading, so a project is never marked on a guess. */
export function projectUntrusted(path: string): boolean {
  watchTrusted();
  const list = trustedList();
  return list !== null && !list.some((t) => t && isUnderPath(path, t));
}
