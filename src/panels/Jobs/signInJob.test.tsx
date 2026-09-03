import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";

// A sign-in is an ordinary PTY with two things bolted on, and both of them are
// silent when they break.
//
// The profile's home variable has to reach the spawned process: without it the
// agent writes into the login the user already had, reports success, and
// leaves two profiles that are one account.
//
// The re-probe has to happen when the process ends: without it a finished login
// keeps reading as signed out until the user goes and finds the button in
// Settings, which is the restart this whole path exists to remove.

const REPO = "/root/work/repo";

const bridge = vi.hoisted(() => ({
  spawned: [] as { id: string; env?: Record<string, string>; args: string[]; autoFocus?: boolean }[],
  invoked: [] as string[],
  // Tauri event listeners, by event name, so a `pty://exit` can be fired.
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    bridge.invoked.push(cmd);
    if (cmd === "refresh_agent_health") return Promise.resolve([]);
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (e: { payload: unknown }) => void) => {
    bridge.listeners.set(name, handler);
    return Promise.resolve(() => {});
  },
  emit: () => Promise.resolve(),
}));

// The props TerminalView receives *are* the pty_spawn arguments, so this is
// where the environment can be read without a live terminal.
vi.mock("../Terminal/TerminalView", () => ({
  default: (props: {
    id: string;
    env?: Record<string, string>;
    args: string[];
    autoFocus?: boolean;
  }) => {
    bridge.spawned.push({
      id: props.id,
      env: props.env,
      args: props.args,
      autoFocus: props.autoFocus,
    });
    return <div data-testid="pty" />;
  },
}));

const { default: Jobs } = await import("./Jobs");
const { emitWith, OPEN_JOB } = await import("../../utils/events");
const { loginJob } = await import("../../utils/signIn");
const store = await import("./jobStore");
type OpenJob = import("../../utils/events").OpenJob;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const SIGN_IN = loginJob(
  "claude",
  "Claude",
  "work",
  "Work",
  { type: "terminal", program: "claude", args: ["auth", "login"], home: ["CLAUDE_CONFIG_DIR", "/canonical/work"] },
  REPO,
)!;

function mount() {
  return render(() => <Jobs />);
}

/** Fire the backend's process-exit event for one job, cleanly by default. */
async function exit(id: string, code: number | null = 0) {
  await waitFor(() => expect(bridge.listeners.has("pty://exit")).toBe(true));
  bridge.listeners.get("pty://exit")!({ payload: { id, code } });
}

beforeEach(() => {
  store.resetJobModel();
  bridge.spawned.length = 0;
  bridge.invoked.length = 0;
  bridge.listeners.clear();
  localStorage.clear();
});

describe("a sign-in job", () => {
  it("spawns the login command with the profile's home variable set", async () => {
    mount();
    emitWith<OpenJob>(OPEN_JOB, SIGN_IN);
    await waitFor(() => expect(bridge.spawned.some((s) => s.id === SIGN_IN.id)).toBe(true));

    const job = bridge.spawned.find((s) => s.id === SIGN_IN.id)!;
    expect(job.env).toEqual({ CLAUDE_CONFIG_DIR: "/canonical/work" });
    expect(job.args).toEqual(["auth", "login"]);
  });

  it("takes the keyboard, because the OAuth flow has to be typed at", async () => {
    mount();
    emitWith<OpenJob>(OPEN_JOB, SIGN_IN);
    await waitFor(() => expect(bridge.spawned.some((s) => s.id === SIGN_IN.id)).toBe(true));
    expect(bridge.spawned.find((s) => s.id === SIGN_IN.id)!.autoFocus).toBe(true);
  });

  it("re-probes agent health when the process ends", async () => {
    mount();
    emitWith<OpenJob>(OPEN_JOB, SIGN_IN);
    await waitFor(() => expect(bridge.spawned.some((s) => s.id === SIGN_IN.id)).toBe(true));

    expect(bridge.invoked).not.toContain("refresh_agent_health");
    await exit(SIGN_IN.id);
    await waitFor(() => expect(bridge.invoked).toContain("refresh_agent_health"));
  });

  // Abandoning the login ends the process too, and re-probing then is right: it
  // re-reads the agent and finds it unchanged, rather than leaving a stale
  // answer behind after a cancel. What must not happen is twice.
  it("re-probes once per job, not once per exit event", async () => {
    mount();
    emitWith<OpenJob>(OPEN_JOB, SIGN_IN);
    await waitFor(() => expect(bridge.spawned.some((s) => s.id === SIGN_IN.id)).toBe(true));

    await exit(SIGN_IN.id, 1);
    await waitFor(() => expect(bridge.invoked).toContain("refresh_agent_health"));
    await exit(SIGN_IN.id, 1);
    expect(bridge.invoked.filter((c) => c === "refresh_agent_health")).toHaveLength(1);
  });

  // Every other job exits too, and none of them changed anybody's sign-in.
  it("leaves ordinary jobs alone", async () => {
    mount();
    const clone: OpenJob = {
      id: "clone-1",
      title: "Clone",
      cwd: REPO,
      program: "git",
      args: ["clone", "x"],
      rediscoverOnExit: true,
    };
    emitWith<OpenJob>(OPEN_JOB, clone);
    await waitFor(() => expect(bridge.spawned.some((s) => s.id === clone.id)).toBe(true));

    const spawned = bridge.spawned.find((s) => s.id === clone.id)!;
    expect(spawned.env).toBeUndefined();
    // A clone opens by itself, so the next keystroke belongs wherever it was
    // already going.
    expect(spawned.autoFocus).toBe(false);

    await exit(clone.id);
    expect(bridge.invoked).not.toContain("refresh_agent_health");
    expect(bridge.invoked).toContain("rediscover");
  });
});
