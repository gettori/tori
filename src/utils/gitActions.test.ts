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
  stagedFiles,
  changedFiles,
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
  // still be loaded. Selecting nothing is the reset the app itself uses.
  await refreshStatus(null);
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

  it("blanks the previous workspace's numbers the moment the root changes", async () => {
    status = [added];
    await refreshGit("/proj");
    expect(stagedFiles()).toHaveLength(1);

    // Synchronous, before any read for the new root can land: the palette must
    // never offer "Commit" on the strength of another workspace's index.
    status = [];
    const pending = refreshGit("/other");
    expect(gitState().root).toBe("/other");
    expect(stagedFiles()).toEqual([]);
    await pending;
  });

  it("drops an in-flight read that a root switch superseded", async () => {
    status = [added];
    const slow = refreshStatus("/proj");
    status = [];
    await refreshStatus("/other");
    await slow;
    // /proj's answer must not be filed under /other.
    expect(gitState().root).toBe("/other");
    expect(gitState().files).toEqual([]);
  });

  it("coalesces two refreshes of the same root into one read", async () => {
    status = [modified];
    await Promise.all([refreshStatus("/proj"), refreshStatus("/proj")]);
    expect(calls.filter((c) => c.cmd === "git_status")).toHaveLength(1);
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

  it("refuses a second push while one is in flight", async () => {
    await refreshGit("/proj");
    const first = push("/proj", "feature");
    expect(await push("/proj", "feature")).toBe(false);
    await vi.waitFor(() => expect(listeners["git://push-done"]?.length).toBeTruthy());
    for (const fn of listeners["git://push-done"]!) fn({ payload: { repo: "/proj" } });
    expect(await first).toBe(true);
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
});
