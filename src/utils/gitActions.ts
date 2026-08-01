// The git actions Sway can take, and the status they act on.
//
// Both live here rather than inside the Changes panel because that panel is
// unmounted whenever the right pane is showing anything else, and a command
// palette entry cannot ask a component that is not on screen whether there is
// anything staged. Module-level for the same reason `chatSessions.ts` is:
// consumers read it without mounting the thing that used to own it.
//
// One module rather than two (actions here, store there) because every action
// invalidates the store, and splitting them would leave each caller to remember
// the refresh - which is exactly the bug the Changes panel had, where staging
// from anywhere else left its list stale.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { emitWith, TOAST, type ToastEvent } from "./events";

/** One porcelain entry. `path` is repo-relative, as every git_* command wants,
 *  and since the backend moved to `--porcelain=v2 -z` it is always a real
 *  pathspec: a rename puts its source in `orig_path` instead of packing both
 *  into one `old -> new` string, and nothing arrives quoted. */
export type FileStatus = {
  status: string;
  path: string;
  orig_path?: string | null;
  staged: boolean;
  unstaged: boolean;
};
export type AheadBehind = { ahead: number; behind: number; has_upstream: boolean };
type BranchInfo = { name: string; current: boolean };

export type GitState = {
  /** The workspace these numbers describe. Carried in the state rather than
   *  beside it so a consumer can never read counts without knowing whose. */
  root: string | null;
  files: FileStatus[];
  branch: string | null;
  aheadBehind: AheadBehind | null;
};

const EMPTY: Omit<GitState, "root"> = { files: [], branch: null, aheadBehind: null };

const [gitState, setGitState] = createSignal<GitState>({ root: null, ...EMPTY });
export { gitState };

export const stagedFiles = () => gitState().files.filter((f) => f.staged);
export const changedFiles = () => gitState().files.filter((f) => f.unstaged);

/** Can a push do anything? A branch with no upstream counts: the push sets it.
 *  Unknown (the probe failed, or nothing is selected) reads as no. */
export function canPush(): boolean {
  const ab = gitState().aheadBehind;
  return !!ab && (!ab.has_upstream || ab.ahead > 0);
}

const [pushing, setPushing] = createSignal(false);
export { pushing };

function toastError(e: unknown) {
  emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
}

// The root every event-driven refresh below is about. Tracked separately from
// the state so an in-flight read can tell it has been superseded.
let currentRoot: string | null = null;

// A refresh already running for the same key is the answer to a second request
// for it: the Changes panel and Editor both refresh on a root change, and
// without this that is two `git status` runs for one switch.
const inFlight = new Map<string, Promise<void>>();

function coalesce(key: string, run: () => Promise<void>): Promise<void> {
  const running = inFlight.get(key);
  if (running) return running;
  const started = run().finally(() => {
    if (inFlight.get(key) === started) inFlight.delete(key);
  });
  inFlight.set(key, started);
  return started;
}

// Switching root blanks the numbers immediately rather than leaving the previous
// workspace's counts on screen (and in the palette's refusal reasons) until the
// new read lands. Returns whether there is anything to read.
function enterRoot(root: string | null): root is string {
  currentRoot = root;
  if (gitState().root !== root) setGitState({ root, ...EMPTY });
  return root !== null;
}

/** Re-read the file list. The cheap refresh, run after a stage or unstage. */
export function refreshStatus(root: string | null): Promise<void> {
  if (!enterRoot(root)) return Promise.resolve();
  return coalesce(`status:${root}`, async () => {
    let files: FileStatus[] = [];
    try {
      files = await invoke<FileStatus[]>("git_status", { projectPath: root });
    } catch {
      files = [];
    }
    // A switch landed while we were reading, so this answer is about a
    // workspace nobody is looking at any more.
    if (currentRoot !== root) return;
    setGitState((prev) => ({ ...prev, files }));
  });
}

/** Re-read branch and ahead/behind. Its own call because it costs two more
 *  backend round trips than the file list and changes far less often. */
export function refreshMeta(root: string | null): Promise<void> {
  if (!enterRoot(root)) return Promise.resolve();
  return coalesce(`meta:${root}`, async () => {
    let branch: string | null = null;
    let aheadBehind: AheadBehind | null = null;
    try {
      branch = (await invoke<BranchInfo[]>("list_branches", { path: root })).find((b) => b.current)?.name ?? null;
    } catch {
      branch = null;
    }
    try {
      aheadBehind = await invoke<AheadBehind>("git_ahead_behind", { projectPath: root });
    } catch {
      aheadBehind = null;
    }
    if (currentRoot !== root) return;
    setGitState((prev) => ({ ...prev, branch, aheadBehind }));
  });
}

/** Everything: run on a root change and after anything that moves HEAD. */
export function refreshGit(root: string | null): Promise<void> {
  return Promise.all([refreshStatus(root), refreshMeta(root)]).then(() => {});
}

// Every action reports failure the same way (a toast) and refreshes the store on
// the way out, so no caller has to remember either.
async function act(root: string, run: () => Promise<unknown>, after: (root: string) => Promise<void>): Promise<boolean> {
  try {
    await run();
  } catch (e) {
    toastError(e);
    return false;
  }
  await after(root);
  return true;
}

export function stage(root: string, paths: string[]): Promise<boolean> {
  return act(root, () => invoke("git_stage", { projectPath: root, paths }), refreshStatus);
}

export function unstage(root: string, paths: string[]): Promise<boolean> {
  return act(root, () => invoke("git_unstage", { projectPath: root, paths }), refreshStatus);
}

/** Commit the staged changes. `amend` rewrites HEAD instead of adding a commit,
 *  and is the one form that needs nothing staged (amending only the message). */
export function commit(root: string, message: string, amend = false): Promise<boolean> {
  return act(root, () => invoke("git_commit", { projectPath: root, message, amend }), refreshGit);
}

/** HEAD's full message, for prefilling the fields when amend is toggled on.
 *  An unborn HEAD (or an unreadable one) reads as empty, not as a failure. */
export async function headMessage(root: string): Promise<string> {
  try {
    return await invoke<string>("git_head_message", { projectPath: root });
  } catch {
    return "";
  }
}

// Resolves once `git://push-done|error` fires for `repo`, so a caller can await
// a push before proceeding (e.g. "Open PR" pushing first). One-shot: both
// listeners are torn down as soon as either fires.
function waitForPush(repo: string): Promise<{ ok: boolean; error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let unDone: UnlistenFn | undefined;
    let unError: UnlistenFn | undefined;
    const finish = (result: { ok: boolean; error: string }) => {
      if (settled) return;
      settled = true;
      unDone?.();
      unError?.();
      resolve(result);
    };
    listen<{ repo: string }>("git://push-done", (e) => {
      if (e.payload.repo === repo) finish({ ok: true, error: "" });
    }).then((un) => (settled ? un() : (unDone = un)));
    listen<{ repo: string; error: string }>("git://push-error", (e) => {
      if (e.payload.repo === repo) finish({ ok: false, error: e.payload.error });
    }).then((un) => (settled ? un() : (unError = un)));
  });
}

/**
 * Push `branch` to origin and wait for the result. The `pushing` flag is shared
 * rather than per-caller: the palette and the Changes panel can both be reached
 * while a push is in flight, and two concurrent pushes of one branch is not a
 * thing either of them should be able to start.
 */
export async function push(root: string, branch: string): Promise<boolean> {
  if (pushing()) return false;
  setPushing(true);
  const result = waitForPush(root);
  try {
    await invoke("git_push", { repo: root, remote: "origin", branch });
  } catch (e) {
    setPushing(false);
    toastError(e);
    return false;
  }
  const { ok, error } = await result;
  setPushing(false);
  if (!ok) {
    toastError(error || "Push failed");
    return false;
  }
  await refreshMeta(root);
  return true;
}

/**
 * Subscribe the store to the git events that change status behind Sway's back.
 *
 * `.git` is watcher-filtered (gotchas), so a fetch that moves the upstream emits
 * no `fs://changed`. Called once from Editor.tsx, which is always mounted, so
 * the numbers stay true with the Changes panel closed.
 */
export async function startGitWatch(): Promise<() => void> {
  const refresh = () => void refreshGit(currentRoot);
  const unlisteners = await Promise.all([
    listen("git://fetch-done", refresh),
    listen("git://fetch-error", refresh),
  ]);
  return () => {
    for (const un of unlisteners) un();
  };
}
