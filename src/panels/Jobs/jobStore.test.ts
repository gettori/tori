// The job model, without a drawer or a terminal in sight.
//
// Two of these assertions are the ones the old code never had. `rediscover` and
// `refreshAgentHealth` hung off two Sets in Terminal.tsx's exit listener with no
// test anywhere, so losing them in the move would have shipped green: a cloned
// project that never appears, and a finished login that still reads signed out.
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoked: string[] = [];
const probes: number[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    invoked.push(cmd);
    return Promise.resolve(null);
  },
}));
vi.mock("../../utils/agentHealth", () => ({
  refreshAgentHealth: () => {
    probes.push(Date.now());
    return Promise.resolve([]);
  },
}));

const store = await import("./jobStore");
type OpenJob = import("../../utils/events").OpenJob;

const CLONE: OpenJob = {
  id: "clone:/space/proj:1",
  title: "clone proj",
  cwd: "/space",
  program: "git",
  args: ["clone", "url"],
  rediscoverOnExit: true,
};

const SIGN_IN: OpenJob = {
  id: "signin:claude:work",
  title: "Sign in to Claude (Work)",
  cwd: "/home/me",
  program: "claude",
  args: ["auth", "login"],
  interactive: true,
  recheckAgentsOnExit: true,
};

beforeEach(() => {
  store.resetJobModel();
  invoked.length = 0;
  probes.length = 0;
});

describe("starting a job", () => {
  it("shows it, and a second start under the same id spawns nothing", () => {
    store.startJob(SIGN_IN);
    expect(store.jobs()).toHaveLength(1);
    expect(store.shownJob()?.id).toBe(SIGN_IN.id);

    store.hideDrawer();
    store.startJob(SIGN_IN);
    expect(store.jobs()).toHaveLength(1);
    // Not a no-op either: the second press reveals the one already running,
    // which is the whole point of pressing it again.
    expect(store.shownJob()?.id).toBe(SIGN_IN.id);
  });

  it("gives the drawer to the newest and leaves the older one a row", () => {
    store.startJob(CLONE);
    store.startJob(SIGN_IN);
    expect(store.shownJob()?.id).toBe(SIGN_IN.id);
    expect(store.jobs().map((j) => j.id)).toEqual([CLONE.id, SIGN_IN.id]);
  });
});

describe("finishing a job", () => {
  it("walks running to ok, and clears the job a clean exit leaves nothing to read", () => {
    store.startJob(CLONE);
    expect(store.jobs()[0].state).toBe("running");

    expect(store.stateForCode(0)).toBe("ok");
    store.finishJob(CLONE.id, 0);
    expect(store.jobs()).toHaveLength(0);
    expect(store.shownJob()).toBeNull();
  });

  it("walks running to failed and stays put on a non-zero code", () => {
    store.startJob(CLONE);
    store.finishJob(CLONE.id, 128);
    expect(store.jobs()[0].state).toBe("failed");
    expect(store.jobs()[0].code).toBe(128);
    expect(store.shownJob()?.id).toBe(CLONE.id);
  });

  it("treats an unconfirmed exit as a failure, not a success", () => {
    store.startJob(CLONE);
    store.finishJob(CLONE.id, null);
    expect(store.jobs()[0].state).toBe("failed");
    expect(store.shownJob()?.id).toBe(CLONE.id);
  });

  it("re-discovers projects when a clone ends, or the clone never appears", () => {
    store.startJob(CLONE);
    store.finishJob(CLONE.id, 0);
    expect(invoked).toContain("rediscover");
  });

  it("re-probes agent health when a sign-in ends, or it still reads signed out", () => {
    store.startJob(SIGN_IN);
    store.finishJob(SIGN_IN.id, 0);
    expect(probes).toHaveLength(1);
  });

  it("runs neither side effect for a job that asked for neither", () => {
    store.startJob({ ...CLONE, rediscoverOnExit: false });
    store.finishJob(CLONE.id, 0);
    expect(invoked).not.toContain("rediscover");
    expect(probes).toHaveLength(0);
  });

  it("ignores a second exit for the same job", () => {
    store.startJob(CLONE);
    store.finishJob(CLONE.id, 1);
    store.finishJob(CLONE.id, 1);
    expect(invoked.filter((c) => c === "rediscover")).toHaveLength(1);
  });
});

describe("dismissing a job", () => {
  it("drops an exited one and refuses a running one", () => {
    store.startJob(CLONE);
    store.dismissJob(CLONE.id);
    expect(store.jobs()).toHaveLength(1);

    store.finishJob(CLONE.id, 1);
    store.dismissJob(CLONE.id);
    expect(store.jobs()).toHaveLength(0);
    expect(store.shownJob()).toBeNull();
  });
});

describe("the drawer's pick", () => {
  it("never points at a job that is gone", () => {
    store.startJob(CLONE);
    store.startJob(SIGN_IN);
    store.finishJob(SIGN_IN.id, 0);
    // The newest is cleared, so the drawer closes rather than silently
    // falling back to the older job the user was not looking at.
    expect(store.shownJob()).toBeNull();
    expect(store.jobs().map((j) => j.id)).toEqual([CLONE.id]);

    store.showJob(CLONE.id);
    expect(store.shownJob()?.id).toBe(CLONE.id);
  });

  it("refuses to show a job that was never started", () => {
    store.showJob("nope");
    expect(store.shownJob()).toBeNull();
  });
});
