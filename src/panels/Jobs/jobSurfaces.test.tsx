import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";

// The two surfaces a job has, and the rule that governs both: a job's
// `TerminalView` is mounted for as long as the job exists, and which one is on
// screen is adoption, never mounting. `TerminalView`'s cleanup calls
// `pty_kill`, so a `Show` around it would end the clone it is reporting on
// ([[lesson_a_mount_gate_is_a_destroy_gate]]).

const bridge = vi.hoisted(() => ({
  invoked: [] as string[],
  mounted: [] as string[],
  cleaned: [] as string[],
  refits: 0,
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    bridge.invoked.push(cmd);
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

// Records mounts and, crucially, kills the PTY on cleanup exactly as the real
// one does. Without that this file could not tell "hidden" from "destroyed",
// which is the only distinction it exists to make.
vi.mock("../Terminal/TerminalView", async () => {
  const { onCleanup } = await import("solid-js");
  const { invoke } = await import("@tauri-apps/api/core");
  return {
    default: (props: { id: string; active: boolean }) => {
      bridge.mounted.push(props.id);
      onCleanup(() => {
        bridge.cleaned.push(props.id);
        invoke("pty_kill", { id: props.id }).catch(() => {});
      });
      return <div data-testid={`pty:${props.id}`} data-active={String(props.active)} />;
    },
  };
});

const { default: Jobs } = await import("./Jobs");
const { default: JobTray } = await import("./JobTray");
const { on, REFIT_PANES } = await import("../../utils/events");
const store = await import("./jobStore");
const terminals = await import("../Terminal/terminalTabStore");
type OpenJob = import("../../utils/events").OpenJob;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const CLONE: OpenJob = {
  id: "clone-1",
  title: "Clone proj",
  cwd: "/space",
  program: "git",
  args: ["clone", "url"],
  rediscoverOnExit: true,
};
const INSTALL: OpenJob = {
  id: "install:claude",
  title: "Install Claude",
  cwd: "/home/me",
  program: "npm",
  args: ["i", "-g", "claude"],
  interactive: true,
};

const hostFor = (id: string) => document.querySelector(`[data-stage-host="${id}"]`);
const drawer = () => document.querySelector('[aria-label="Job output"]')!;
const drawerHidden = () => /hidden/.test(drawer().className);

let mounted: ReturnType<typeof render> | null = null;
let offRefit: (() => void) | undefined;

async function exit(id: string, code: number | null) {
  await waitFor(() => expect(bridge.listeners.has("pty://exit")).toBe(true));
  bridge.listeners.get("pty://exit")!({ payload: { id, code } });
}

beforeEach(() => {
  store.resetJobModel();
  terminals.resetTerminalTabModel();
  bridge.invoked.length = 0;
  bridge.mounted.length = 0;
  bridge.cleaned.length = 0;
  bridge.refits = 0;
  bridge.listeners.clear();
  localStorage.clear();
  offRefit = on(REFIT_PANES, () => {
    bridge.refits += 1;
  });
});
afterEach(() => {
  offRefit?.();
  mounted?.unmount();
  mounted = null;
  store.resetJobModel();
});

async function start(job: OpenJob) {
  // `OPEN_JOB` opens a command tab now, so the surfaces phase 5 deletes are
  // driven through the store they were always a view of.
  store.startJob(job);
  await waitFor(() => expect(bridge.mounted).toContain(job.id));
}

describe("the drawer", () => {
  it("opens on a job and shows its surface", async () => {
    mounted = render(() => <Jobs />);
    await start(CLONE);
    expect(drawerHidden()).toBe(false);
    await waitFor(() => expect(hostFor(CLONE.id)?.parentElement).toBe(drawer().lastElementChild));
  });

  it("survives being closed and reopened, with no kill in between", async () => {
    mounted = render(() => <Jobs />);
    await start(CLONE);

    fireEvent.click(document.querySelector('[aria-label="Close job output"]')!);
    await waitFor(() => expect(drawerHidden()).toBe(true));
    store.showJob(CLONE.id);
    await waitFor(() => expect(drawerHidden()).toBe(false));

    expect(bridge.cleaned).toEqual([]);
    expect(bridge.invoked).not.toContain("pty_kill");
  });

  it("moves to the newest job without remounting the one it displaced", async () => {
    mounted = render(() => <Jobs />);
    await start(CLONE);
    await start(INSTALL);

    expect(store.shownJob()?.id).toBe(INSTALL.id);
    // Mounted once each. A remount would have spawned the clone a second time.
    expect(bridge.mounted).toEqual([CLONE.id, INSTALL.id]);
    expect(bridge.cleaned).toEqual([]);
    // Still on screen, just not the one being shown.
    expect(hostFor(CLONE.id)).toBeTruthy();
  });

  it("refits on the hidden to visible edge, which is what resizes the pty", async () => {
    mounted = render(() => <Jobs />);
    await start(CLONE);
    // Adoption asks for the refit after layout; the surface reads its new box
    // there, because mid-flush the box has no size yet.
    await waitFor(() => expect(bridge.refits).toBeGreaterThan(0));

    const before = bridge.refits;
    await start(INSTALL);
    await waitFor(() => expect(bridge.refits).toBeGreaterThan(before));
  });
});

describe("a job ending", () => {
  it("clears itself on a clean exit, drawer and stage host included", async () => {
    mounted = render(() => <Jobs />);
    await start(CLONE);
    await exit(CLONE.id, 0);

    await waitFor(() => expect(drawerHidden()).toBe(true));
    expect(store.jobs()).toHaveLength(0);
    expect(hostFor(CLONE.id)).toBeNull();
    expect(bridge.cleaned).toEqual([CLONE.id]);
  });

  it("stays on screen on a non-zero code, wearing it", async () => {
    mounted = render(() => <Jobs />);
    await start(CLONE);
    await exit(CLONE.id, 128);

    expect(drawerHidden()).toBe(false);
    expect(drawer().textContent).toContain("exit 128");
    expect(hostFor(CLONE.id)).toBeTruthy();
    // The sharp one. Recording the exit replaces the job object, and `For`
    // diffs by reference: iterating jobs rather than ids rebuilt the surface
    // here, killing the PTY and wiping the output the failure exists to show.
    expect(bridge.mounted).toEqual([CLONE.id]);
    expect(bridge.cleaned).toEqual([]);
  });

  it("stays on screen on an exit it could not confirm", async () => {
    mounted = render(() => <Jobs />);
    await start(CLONE);
    await exit(CLONE.id, null);

    expect(drawerHidden()).toBe(false);
    expect(drawer().textContent).toContain("no exit status");
  });
});

describe("the tray", () => {
  it("renders nothing at all while there is nothing to say", () => {
    mounted = render(() => <JobTray />);
    expect(document.querySelector('[aria-label="Jobs"]')).toBeNull();
  });

  it("gives a row to each job and a way back to its output", async () => {
    mounted = render(() => (
      <>
        <Jobs />
        <JobTray />
      </>
    ));
    await start(CLONE);
    await start(INSTALL);

    const rows = () => document.querySelectorAll('[aria-label="Jobs"] [role="listitem"]');
    await waitFor(() => expect(rows()).toHaveLength(2));

    store.hideDrawer();
    await waitFor(() => expect(drawerHidden()).toBe(true));
    fireEvent.click(rows()[0].querySelector("button")!);
    await waitFor(() => expect(store.shownJob()?.id).toBe(CLONE.id));
    expect(drawerHidden()).toBe(false);
  });

  it("offers Dismiss only once a job has exited, and takes its host with it", async () => {
    mounted = render(() => (
      <>
        <Jobs />
        <JobTray />
      </>
    ));
    await start(CLONE);
    expect(document.querySelector(`[aria-label="Dismiss ${CLONE.title}"]`)).toBeNull();

    await exit(CLONE.id, 1);
    const dismiss = await waitFor(() =>
      document.querySelector<HTMLElement>(`[aria-label="Dismiss ${CLONE.title}"]`),
    );
    fireEvent.click(dismiss!);

    await waitFor(() => expect(document.querySelector('[aria-label="Jobs"]')).toBeNull());
    expect(hostFor(CLONE.id)).toBeNull();
  });
});

describe("what a job leaves alone", () => {
  // The bug this whole change exists for. A command tab claimed a workspace of
  // its own cwd, so `activeWorkspace` moved to a key with no layout envelope
  // and every real tab of the unit the user was in went off screen.
  it("never moves the terminal pane's workspace or its visible tab", async () => {
    terminals.setOpen([
      {
        id: "sh:1",
        title: "zsh",
        cwd: "/space/proj/main",
        workspace: "/space/proj/main",
        kind: "shell",
        program: "/bin/zsh",
        args: [],
        profile: null,
      },
    ]);
    terminals.focusTab("/space/proj/main", "sh:1");

    mounted = render(() => <Jobs />);
    await start(CLONE);

    expect(terminals.activeWorkspace()).toBe("/space/proj/main");
    expect(terminals.visibleId()).toBe("sh:1");
  });
});
