// The git actions Tori can take, and the status they act on.
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
//
// One slot per root, not one slot total: inside a Topic every member is a
// repo of its own, and the member in front is a pointer into the set rather
// than the only one whose numbers are true.
import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { emitWith, TOAST, type FsChanged, type ToastEvent } from "./events";
import { rootOf } from "./topics";
import { mentionPath } from "./pathScope";

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
  /** Unmerged index stages: the file is mid-conflict. Mutually exclusive with
   *  the other two, so a conflicted file falls out of both sections rather than
   *  offering stage, unstage or discard, none of which git performs on one.
   *  Optional only so a fixture may omit it; the backend always sends it. */
  conflicted?: boolean;
};
export type AheadBehind = { ahead: number; behind: number; has_upstream: boolean };

/** One row of `git_log`. Mirrors `LogEntry` in src-tauri/src/git.rs.
 *
 *  Here rather than beside a view, because the three that read it (the graph
 *  tab, the panel's Graph section, the lane layout in `commitGraph.ts`) would
 *  otherwise all import it from whichever one happened to declare it. */
export type LogEntry = {
  sha: string;
  short: string;
  subject: string;
  author: string;
  relative_date: string;
  /** Committer time, unix seconds. */
  committed_at: number;
  refs: string[];
  /** Full parent shas: one ordinarily, several for a merge, none for a root. */
  parents: string[];
  /** On HEAD but not on its upstream. */
  unpushed: boolean;
  /** On a local branch but not on the base branch: the branch's own work. */
  off_base: boolean;
};

type BranchInfo = { name: string; current: boolean };

export type GitState = {
  /** The workspace these numbers describe. Carried in the state rather than
   *  beside it so a consumer can never read counts without knowing whose. */
  root: string | null;
  files: FileStatus[];
  branch: string | null;
  aheadBehind: AheadBehind | null;
  /** The commit HEAD names, or null on an unborn branch. Read here because it
   *  is what everything derived from committed history caches against: blame
   *  cannot change while HEAD stands still, however much you type. */
  head: string | null;
};

/** A file with the member it came from, for the reads that span a Topic. */
export type RootedFile = FileStatus & { root: string };

// One object for every root with no slot, so a consumer memo comparing `files`
// by identity sees no change on each read of one. `root: null` is what makes a
// slotless read distinguishable from an entered member that has not answered
// yet: the first knows nothing, the second knows it is clean so far.
const NO_FILES: FileStatus[] = [];
const NO_SLOT: GitState = { root: null, files: NO_FILES, branch: null, aheadBehind: null, head: null };

// The slot map, in the order the roots were entered, which is member order.
const [slots, setSlots] = createSignal<ReadonlyMap<string, GitState>>(new Map());
// Which slot the surfaces that only ever describe one repo are about.
const [activeRoot, setActiveRoot] = createSignal<string | null>(null);
export { setActiveRoot };

/** This root's numbers. A root nobody entered reads blank rather than reading
 *  somebody else's, which is what keeps every consumer failing closed. */
export function gitStateFor(root: string | null | undefined): GitState {
  return (root ? slots().get(root) : null) ?? NO_SLOT;
}

/** The active member's slot: what a surface showing one repo at a time reads. */
export const gitState = () => gitStateFor(activeRoot());

const filesIn = (root?: string | null) => (root === undefined ? gitState() : gitStateFor(root)).files;

export const stagedFiles = (root?: string | null) => filesIn(root).filter((f) => f.staged);
export const changedFiles = (root?: string | null) => filesIn(root).filter((f) => f.unstaged);
export const conflictedFiles = (root?: string | null) => filesIn(root).filter((f) => f.conflicted);

// Deliberately not the no-argument form of the three above: a union under those
// names would compile clean at every existing call site and quietly arm the
// palette to commit one member's index on another member's staged file.
function across(pick: (f: FileStatus) => boolean | undefined): RootedFile[] {
  const out: RootedFile[] = [];
  for (const [root, state] of slots()) {
    for (const f of state.files) if (pick(f)) out.push({ ...f, root });
  }
  return out;
}

/** Every entered member's staged files, tagged with the member. */
export const stagedAcross = (): RootedFile[] => across((f) => f.staged);
export const changedAcross = (): RootedFile[] => across((f) => f.unstaged);
export const conflictedAcross = (): RootedFile[] => across((f) => f.conflicted);

/**
 * Is this file mid-conflict in the member that owns it?
 *
 * Takes the **absolute** path, because that is what the editor holds and the
 * store's paths are repo-relative; the two coordinate systems have to meet
 * somewhere, and it may as well be the one place that knows both.
 *
 * Resolved through `rootOf` rather than against one root, so a file open from a
 * background member answers about that member instead of failing closed.
 */
export function isConflicted(roots: readonly string[] | null | undefined, absPath: string | null): boolean {
  const root = rootOf(absPath, roots);
  if (!root || !absPath) return false;
  const rel = mentionPath(absPath, root);
  return gitStateFor(root).files.some((f) => f.conflicted && f.path === rel);
}

/** Can a push do anything? A branch with no upstream counts: the push sets it.
 *  Unknown (the probe failed, or nothing is selected) reads as no. Takes the
 *  member to ask about, defaulting to the one in front, like the file lists. */
export function canPush(root?: string | null): boolean {
  const ab = (root === undefined ? gitState() : gitStateFor(root)).aheadBehind;
  return !!ab && (!ab.has_upstream || ab.ahead > 0);
}

// Per root, not one flag: a Topic draws a Push per member, and one shared
// flag would label every one of them "Pushing..." for a push in any one.
const [pushingRoots, setPushingRoots] = createSignal<ReadonlySet<string>>(new Set());

/** Is a push in flight in this member? */
export const pushingIn = (root: string | null | undefined): boolean => !!root && pushingRoots().has(root);

function markPushing(root: string, on: boolean): void {
  setPushingRoots((prev) => {
    if (prev.has(root) === on) return prev;
    const next = new Set(prev);
    if (on) next.add(root);
    else next.delete(root);
    return next;
  });
}

function toastError(e: unknown) {
  emitWith<ToastEvent>(TOAST, { message: String(e), kind: "error" });
}

// Which generation of membership each entered root is on. Doubles as the
// membership set itself, and as the stale-answer guard: a read files its answer
// only while the root it asked about is still the one it entered.
const epochs = new Map<string, number>();
let epoch = 0;

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

function writeSlot(root: string, patch: Partial<GitState>): void {
  const prev = slots();
  const cur = prev.get(root);
  if (!cur) return;
  const next = new Map(prev);
  next.set(root, { ...cur, ...patch });
  setSlots(next);
}

/**
 * Declare which roots the store is about, and which of them is in front.
 *
 * The only writer of membership. A refresh fills a slot and never opens or
 * closes one, so committing in one member cannot drop the numbers of the
 * members beside it - which is exactly what `enterRoot`-inside-`refreshStatus`
 * did when the store held a single slot.
 *
 * Roots outside the new set go immediately rather than after their replacement
 * lands: the palette must never offer "Commit" on the strength of a workspace
 * nobody is looking at any more.
 */
export function enterRoots(roots: readonly string[], active: string | null = roots[0] ?? null): void {
  const prev = slots();
  const next = new Map<string, GitState>();
  for (const root of roots) {
    const cur = prev.get(root);
    if (cur) {
      next.set(root, cur);
      continue;
    }
    epochs.set(root, ++epoch);
    next.set(root, { root, files: [], branch: null, aheadBehind: null, head: null });
  }
  for (const root of epochs.keys()) if (!next.has(root)) epochs.delete(root);
  setActiveRoot(active && next.has(active) ? active : (roots[0] ?? null));
  setSlots(next);
}

/** Re-read the file list. The cheap refresh, run after a stage or unstage. */
export function refreshStatus(root: string | null): Promise<void> {
  const at = root ? epochs.get(root) : undefined;
  if (!root || at === undefined) return Promise.resolve();
  // Keyed by generation as well as root: a root that left the set and came
  // back is a new question, and joining the answer to the old one (which this
  // guard is about to discard) would leave the slot blank for good.
  return coalesce(`status:${root}#${at}`, async () => {
    let files: FileStatus[] = [];
    try {
      files = await invoke<FileStatus[]>("git_status", { projectPath: root });
    } catch {
      files = [];
    }
    // The root left the set while we were reading, so this answer is about a
    // workspace nobody is looking at any more.
    if (epochs.get(root) !== at) return;
    writeSlot(root, { files });
  });
}

/** Re-read branch, ahead/behind and HEAD. Its own call because it costs more
 *  backend round trips than the file list and changes far less often: it runs
 *  on the events that move HEAD, not on every save. */
export function refreshMeta(root: string | null): Promise<void> {
  const at = root ? epochs.get(root) : undefined;
  if (!root || at === undefined) return Promise.resolve();
  return coalesce(`meta:${root}#${at}`, async () => {
    // Three independent probes, so three at once: they were serial while there
    // were two of them, and a third would have made this refresh visibly slower
    // than the file list it runs beside. Each keeps its own failure, so one
    // probe going wrong still leaves the other two answered.
    const [branch, aheadBehind, head] = await Promise.all([
      invoke<BranchInfo[]>("list_branches", { path: root })
        .then((bs) => bs.find((b) => b.current)?.name ?? null)
        .catch(() => null),
      invoke<AheadBehind>("git_ahead_behind", { projectPath: root }).catch(() => null),
      invoke<string>("git_head_sha", { projectPath: root })
        .then((sha) => sha || null)
        .catch(() => null),
    ]);
    if (epochs.get(root) !== at) return;
    writeSlot(root, { branch, aheadBehind, head });
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
export function commit(root: string, message: string, amend = false, signoff = false): Promise<boolean> {
  return act(
    root,
    () => invoke("git_commit", { projectPath: root, message, amend, signoff }),
    refreshGit,
  );
}

/** What an integrate attempt did. Mirrors `IntegrateOutcome` in git.rs: a
 *  conflict is an outcome, not a failure, and lands in the Conflicts group. */
export type IntegrateOutcome = { conflicted: boolean; message: string };

/** Stage everything changed in this root, conflicts excluded: git refuses `add`
 *  on an unmerged path, so including them would fail the whole call. */
export function stageAll(root: string): Promise<boolean> {
  const paths = changedFiles(root).map((f) => f.path);
  return paths.length ? stage(root, paths) : Promise.resolve(false);
}

export function unstageAll(root: string): Promise<boolean> {
  const paths = stagedFiles(root).map((f) => f.path);
  return paths.length ? unstage(root, paths) : Promise.resolve(false);
}

/** Fire-and-forget: the answer arrives as `git://fetch-done`, which the store
 *  is already listening for. */
export function fetchIn(root: string): Promise<boolean> {
  return act(root, () => invoke("git_fetch", { repo: root }), refreshMeta);
}

/** Pull, waiting for the background op's own event. Separate from `fetchIn`
 *  because a pull can stop on a conflict, which is a state the file list has to
 *  be re-read to show. */
export async function pull(root: string, rebase = false): Promise<boolean> {
  const result = waitFor(root, "git://pull-done", "git://pull-error");
  try {
    await invoke("git_pull", { repo: root, rebase });
  } catch (e) {
    toastError(e);
    return false;
  }
  const { ok, error } = await result;
  await refreshGit(root);
  if (!ok) {
    toastError(error || "Pull failed");
    return false;
  }
  return true;
}

export async function merge(root: string, branch: string): Promise<IntegrateOutcome | null> {
  return integrate(root, "git_merge", { projectPath: root, branch });
}

export async function rebase(root: string, onto: string): Promise<IntegrateOutcome | null> {
  return integrate(root, "git_rebase", { projectPath: root, onto });
}

async function integrate(
  root: string,
  cmd: string,
  args: Record<string, unknown>,
): Promise<IntegrateOutcome | null> {
  try {
    const out = await invoke<IntegrateOutcome>(cmd, args);
    await refreshGit(root);
    return out;
  } catch (e) {
    await refreshGit(root);
    toastError(e);
    return null;
  }
}

export function abortIntegrate(root: string): Promise<boolean> {
  return act(root, () => invoke("git_abort", { projectPath: root }), refreshGit);
}

/** Undo the last commit, keeping its changes staged. */
export function undoLastCommit(root: string): Promise<boolean> {
  return act(root, () => invoke("git_undo_last_commit", { projectPath: root }), refreshGit);
}

export function createBranch(root: string, name: string, from?: string, checkout = true): Promise<boolean> {
  return act(root, () => invoke("git_branch_create", { projectPath: root, name, from, checkout }), refreshGit);
}

export function renameBranch(root: string, from: string, to: string): Promise<boolean> {
  return act(root, () => invoke("git_branch_rename", { projectPath: root, from, to }), refreshGit);
}

export function deleteBranch(root: string, branch: string, force = false): Promise<boolean> {
  return act(root, () => invoke("git_branch_delete", { projectPath: root, branch, force }), refreshGit);
}

/** Stash the index alone, leaving the worktree. */
export function stashStaged(root: string, message?: string): Promise<boolean> {
  return act(
    root,
    () => invoke("git_stash_push", { projectPath: root, message, staged: true }),
    refreshStatus,
  );
}

/** This root's branch names, for the pickers. Empty rather than throwing: a
 *  repo that cannot be read has no branches to offer. */
export async function branchNames(root: string): Promise<string[]> {
  try {
    const list = await invoke<BranchInfo[]>("list_branches", { path: root });
    return list.map((b) => b.name);
  } catch {
    return [];
  }
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
function waitFor(
  repo: string,
  done: string,
  failed: string,
): Promise<{ ok: boolean; error: string }> {
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
    listen<{ repo: string }>(done, (e) => {
      if (e.payload.repo === repo) finish({ ok: true, error: "" });
    }).then((un) => (settled ? un() : (unDone = un)));
    listen<{ repo: string; error: string }>(failed, (e) => {
      if (e.payload.repo === repo) finish({ ok: false, error: e.payload.error });
    }).then((un) => (settled ? un() : (unError = un)));
  });
}

function waitForPush(repo: string): Promise<{ ok: boolean; error: string }> {
  return waitFor(repo, "git://push-done", "git://push-error");
}

/**
 * Push `branch` to origin and wait for the result. The flag is per root rather
 * than per caller: the palette and the Changes panel can both be reached while
 * a push is in flight, and two concurrent pushes of one branch is not a thing
 * either of them should be able to start.
 */
export async function push(root: string, branch: string): Promise<boolean> {
  if (pushingIn(root)) return false;
  markPushing(root, true);
  const result = waitForPush(root);
  try {
    await invoke("git_push", { repo: root, remote: "origin", branch });
  } catch (e) {
    markPushing(root, false);
    toastError(e);
    return false;
  }
  const { ok, error } = await result;
  markPushing(root, false);
  if (!ok) {
    toastError(error || "Push failed");
    return false;
  }
  await refreshMeta(root);
  return true;
}

/**
 * Subscribe the store to the events that change status behind Tori's back.
 *
 * Watcher bursts included, because the Changes panel is unmounted whenever the
 * right pane shows anything else and the palette still has to know what is
 * staged. `.git` is watcher-filtered (gotchas), so a fetch that moves the
 * upstream emits no `fs://changed` and arrives on its own event instead.
 * Called once from Editor.tsx, which is always mounted.
 */
export async function startGitWatch(): Promise<() => void> {
  // A payload naming no root predates the per-root events and is taken as
  // "somewhere in here", which is every entered member.
  const refreshOne = (root: string | undefined, run: (root: string) => Promise<void>) => {
    if (root) void run(root);
    else for (const r of [...epochs.keys()]) void run(r);
  };
  const unlisteners = await Promise.all([
    listen<FsChanged>("fs://changed", (e) => refreshOne(e.payload?.root, refreshStatus)),
    listen<{ repo?: string }>("git://fetch-done", (e) => refreshOne(e.payload?.repo, refreshGit)),
    listen<{ repo?: string }>("git://fetch-error", (e) => refreshOne(e.payload?.repo, refreshGit)),
  ]);
  return () => {
    for (const un of unlisteners) un();
  };
}
