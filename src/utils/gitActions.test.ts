import { describe, it, expect, vi, beforeEach } from "vitest";

// The point of this module is that nothing has to be mounted for it to be true:
// the Changes panel is unmounted whenever the right pane shows anything else,
// and the command palette still has to know whether there is anything staged.
// So every test here drives the store directly, with no component in sight.

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
// What `git_status` answers next. Actions flip it, so a refresh that did not run
// is visible as a store that still holds the previous answer.
let status: unknown[] = [];
let fail: string | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (fail && cmd === fail) return Promise.reject("boom");
    switch (cmd) {
      case "git_status":
        return Promise.resolve(status);
      case "list_branches":
        return Promise.resolve([{ name: "feature", current: true }]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 2, behind: 0, has_upstream: true });
      default:
        return Promise.resolve(null);
    }
  },
}));

const listeners: Record<string, ((e: { payload: unknown }) => void)[]> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: (e: { payload: unknown }) => void) => {
    (listeners[name] ??= []).push(fn);
    return Promise.resolve(() => {
      listeners[name] = (listeners[name] ?? []).filter((f) => f !== fn);
    });
  },
}));

const {
  gitState,
  gitStateFor,
  enterRoots,
  isConflicted,
  stagedFiles,
  changedFiles,
  stagedAcross,
  changedAcross,
  pushingIn,
  canPush,
  refreshGit,
  refreshStatus,
  stage,
  unstage,
  commit,
  push,
  startGitWatch,
} = await import("./gitActions");
const { TOAST } = await import("./events");

const modified = { status: " M", path: "src/a.ts", staged: false, unstaged: true };
const added = { status: "M ", path: "src/a.ts", staged: true, unstaged: false };
const conflicted = { status: "UU", path: "src/a.ts", staged: false, unstaged: false, conflicted: true };

// The suite runs in the node environment, so `window` is stubbed rather than
// spied on - the same stand-in `hotkeys.test.ts` uses. Only `dispatchEvent` is
// needed: the toast rides emitWith().
let dispatched: CustomEvent[] = [];

/** Toast messages emitted while `fn` ran. */
async function toastsFrom(fn: () => Promise<unknown>): Promise<string[]> {
  const before = dispatched.length;
  await fn();
  return dispatched
    .slice(before)
    .filter((e) => e.type === TOAST)
    .map((e) => (e.detail as { message: string }).message);
}

beforeEach(async () => {
  dispatched = [];
  vi.stubGlobal("window", {
    dispatchEvent: (e: CustomEvent) => {
      dispatched.push(e);
      return true;
    },
  });
  // The store is module-level, so a previous test's workspace would otherwise
  // still be loaded. Re-entering is the reset the app itself uses: it drops
  // every other slot and seeds this one blank.
  enterRoots(["/proj"]);
  calls.length = 0;
  status = [];
  fail = null;
  for (const key of Object.keys(listeners)) delete listeners[key];
});

describe("the shared git store", () => {
  it("loads a workspace's status, branch and ahead/behind", async () => {
    status = [modified];
    await refreshGit("/proj");
    expect(gitState().root).toBe("/proj");
    expect(changedFiles()).toEqual([modified]);
    expect(gitState().branch).toBe("feature");
    expect(canPush()).toBe(true);
  });

  it("updates after a stage, with nothing mounted", async () => {
    status = [modified];
    await refreshGit("/proj");
    expect(stagedFiles()).toEqual([]);

    status = [added];
    expect(await stage("/proj", ["src/a.ts"])).toBe(true);

    expect(calls.some((c) => c.cmd === "git_stage")).toBe(true);
    expect(stagedFiles()).toEqual([added]);
    expect(changedFiles()).toEqual([]);
  });

  it("updates after an unstage and after a commit", async () => {
    status = [added];
    await refreshGit("/proj");

    status = [modified];
    expect(await unstage("/proj", ["src/a.ts"])).toBe(true);
    expect(stagedFiles()).toEqual([]);

    status = [];
    expect(await commit("/proj", "a message")).toBe(true);
    expect(gitState().files).toEqual([]);
    // A commit moves HEAD, so it re-reads ahead/behind too, which a stage does not.
    expect(calls.filter((c) => c.cmd === "git_ahead_behind").length).toBe(2);
  });

  it("keeps a slot per member, each answering only about itself", async () => {
    enterRoots(["/a", "/b"]);
    status = [added];
    await refreshGit("/a");
    status = [modified];
    await refreshGit("/b");

    expect(stagedFiles("/a")).toEqual([added]);
    expect(stagedFiles("/b")).toEqual([]);
    expect(changedFiles("/b")).toEqual([modified]);
    // No argument still means the member in front, so the palette's guards read
    // one repo rather than a union it would then commit in the wrong one.
    expect(gitState().root).toBe("/a");
    expect(stagedFiles()).toEqual([added]);
    // The union is a separate name, and carries whose each row is.
    expect(stagedAcross()).toEqual([{ ...added, root: "/a" }]);
    expect(changedAcross()).toEqual([{ ...modified, root: "/b" }]);
  });

  it("drops the workspace it leaves and leaves the members beside it alone", async () => {
    enterRoots(["/a", "/b"]);
    status = [added];
    await Promise.all([refreshGit("/a"), refreshGit("/b")]);
    expect(stagedFiles("/a")).toHaveLength(1);

    // A refresh fills a slot; only entering opens or closes one. So committing
    // in one member cannot blank the member next to it.
    status = [];
    await refreshGit("/b");
    expect(stagedFiles("/a")).toHaveLength(1);

    // And the drop is synchronous, before any read for the new set can land:
    // the palette must never offer "Commit" on the strength of a workspace
    // nobody is in any more.
    enterRoots(["/b", "/c"]);
    expect(gitStateFor("/a").files).toEqual([]);
    expect(gitStateFor("/c").files).toEqual([]);
    expect(gitState().root).toBe("/b");
    expect(stagedAcross()).toEqual([]);
  });

  it("answers about the member that owns the file, not the member in front", async () => {
    enterRoots(["/a", "/b"]);
    status = [conflicted];
    await refreshStatus("/b");
    status = [];
    await refreshStatus("/a");

    // Same relative path in both members, conflicted in only one of them.
    expect(gitState().root).toBe("/a");
    expect(isConflicted(["/a", "/b"], "/b/src/a.ts")).toBe(true);
    expect(isConflicted(["/a", "/b"], "/a/src/a.ts")).toBe(false);
    // A file under no member (a `.shared/` file, say) is not something
    // git has anything to say about.
    expect(isConflicted(["/a", "/b"], "/elsewhere/src/a.ts")).toBe(false);
  });

  it("refuses to fill a slot nobody opened", async () => {
    status = [added];
    await refreshGit("/elsewhere");
    expect(gitStateFor("/elsewhere").root).toBeNull();
    expect(calls.filter((c) => c.cmd === "git_status")).toHaveLength(0);
  });

  it("drops an in-flight read whose root left the set, and files one that stayed", async () => {
    enterRoots(["/a", "/b"]);
    status = [added];
    const slow = refreshStatus("/a");
    // Out and back: the same path, a new generation, so the answer in flight is
    // about a set that no longer exists.
    enterRoots(["/b"]);
    enterRoots(["/a", "/b"]);
    await slow;
    expect(gitStateFor("/a").files).toEqual([]);

    // A read that outlives nothing is filed as usual.
    await refreshStatus("/a");
    expect(stagedFiles("/a")).toEqual([added]);
  });

  it("coalesces two refreshes of the same root into one read, and re-reads after a re-entry", async () => {
    status = [modified];
    await Promise.all([refreshStatus("/proj"), refreshStatus("/proj")]);
    expect(calls.filter((c) => c.cmd === "git_status")).toHaveLength(1);

    // A new generation is a new question, so it is not answered by the read the
    // previous one is about to discard.
    enterRoots(["/proj"]);
    await refreshStatus("/proj");
    expect(calls.filter((c) => c.cmd === "git_status")).toHaveLength(2);
    expect(changedFiles("/proj")).toEqual([modified]);
  });

  it("leaves no slot behind when the selection empties, as a deleted Feature's does", async () => {
    enterRoots(["/a", "/b"]);
    status = [modified];
    await Promise.all([refreshGit("/a"), refreshGit("/b")]);
    expect(changedAcross()).toHaveLength(2);

    enterRoots([]);
    expect(changedAcross()).toEqual([]);
    expect(gitState().root).toBeNull();
  });

  it("toasts a failed action and leaves the store alone", async () => {
    status = [modified];
    await refreshGit("/proj");
    fail = "git_stage";
    const seen = await toastsFrom(() => stage("/proj", ["src/a.ts"]));
    expect(seen).toEqual(["boom"]);
    expect(changedFiles()).toEqual([modified]);
  });

  it("reports a push failure from the event, not the invoke", async () => {
    await refreshGit("/proj");
    const result = push("/proj", "feature");
    // The invoke resolves as soon as the push is spawned; the outcome arrives
    // on git://push-error, which is what the caller has to wait for.
    await vi.waitFor(() => expect(listeners["git://push-error"]?.length).toBeTruthy());
    for (const fn of listeners["git://push-error"]!) fn({ payload: { repo: "/proj", error: "rejected" } });
    expect(await result).toBe(false);
  });

  it("refuses a second push while one is in flight, per member", async () => {
    enterRoots(["/a", "/b"]);
    const first = push("/a", "feature");
    expect(await push("/a", "feature")).toBe(false);
    // The flag is the member's, not the store's: a push in one leaves the Push
    // beside it live rather than labelling every member "Pushing…".
    expect(pushingIn("/a")).toBe(true);
    expect(pushingIn("/b")).toBe(false);
    await vi.waitFor(() => expect(listeners["git://push-done"]?.length).toBeTruthy());
    for (const fn of listeners["git://push-done"]!) fn({ payload: { repo: "/a" } });
    expect(await first).toBe(true);
    expect(pushingIn("/a")).toBe(false);
  });

  it("refreshes on a fetch landing, so the panel need not be open", async () => {
    status = [];
    await refreshGit("/proj");
    const stop = await startGitWatch();

    status = [modified];
    for (const fn of listeners["git://fetch-done"] ?? []) fn({ payload: null });
    await vi.waitFor(() => expect(changedFiles()).toEqual([modified]));
    stop();
    expect(listeners["git://fetch-done"]).toHaveLength(0);
  });

  it("refreshes the member a burst names, and only that one", async () => {
    enterRoots(["/a", "/b"]);
    status = [];
    await Promise.all([refreshGit("/a"), refreshGit("/b")]);
    const stop = await startGitWatch();

    status = [modified];
    for (const fn of listeners["fs://changed"] ?? []) fn({ payload: { root: "/b", paths: ["/b/src/a.ts"] } });
    await vi.waitFor(() => expect(changedFiles("/b")).toEqual([modified]));
    expect(changedFiles("/a")).toEqual([]);

    // A fetch names its repo the same way, on the event `.git` being
    // watcher-filtered means the burst never arrives on.
    for (const fn of listeners["git://fetch-done"] ?? []) fn({ payload: { repo: "/a" } });
    await vi.waitFor(() => expect(changedFiles("/a")).toEqual([modified]));
    stop();
  });
});
