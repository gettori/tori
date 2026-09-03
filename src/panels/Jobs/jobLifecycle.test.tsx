import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, waitFor } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";

// Stopping a job, and hearing about one that ended.
//
// Both exist for the same reason: a job runs somewhere the user is not
// necessarily looking. The drawer can be closed, the tray lives in a sidebar
// that can be hidden, and a clone that failed with nothing on screen saying so
// is a clone the user waits on forever.

const bridge = vi.hoisted(() => ({
  invoked: [] as { cmd: string; args: unknown }[],
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => {
    bridge.invoked.push({ cmd, args });
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
vi.mock("../Terminal/TerminalView", () => ({
  default: (props: { id: string }) => <div data-testid={`pty:${props.id}`} />,
}));

const { default: Jobs } = await import("./Jobs");
const { default: JobTray } = await import("./JobTray");
const { emitWith, on, onWith, OPEN_JOB, REVEAL_SIDEBAR, TOAST } = await import("../../utils/events");
const store = await import("./jobStore");
type OpenJob = import("../../utils/events").OpenJob;
type ToastEvent = import("../../utils/events").ToastEvent;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const BOOTSTRAP: OpenJob = {
  id: "bootstrap:/space/proj",
  title: "bootstrap proj",
  cwd: "/space",
  program: "sh",
  args: ["-c", "script"],
  rediscoverOnExit: true,
};

const toasts: ToastEvent[] = [];
const reveals: number[] = [];
let mounted: ReturnType<typeof render> | null = null;
let offToast: (() => void) | undefined;
let offReveal: (() => void) | undefined;

const killed = () => bridge.invoked.filter((i) => i.cmd === "pty_kill");

async function exit(id: string, code: number | null) {
  await waitFor(() => expect(bridge.listeners.has("pty://exit")).toBe(true));
  bridge.listeners.get("pty://exit")!({ payload: { id, code } });
}

async function start(job: OpenJob) {
  emitWith<OpenJob>(OPEN_JOB, job);
  await waitFor(() => expect(store.jobs().some((j) => j.id === job.id)).toBe(true));
}

beforeEach(() => {
  store.resetJobModel();
  bridge.invoked.length = 0;
  bridge.listeners.clear();
  toasts.length = 0;
  reveals.length = 0;
  localStorage.clear();
  offToast = onWith<ToastEvent>(TOAST, (t) => void toasts.push(t));
  offReveal = on(REVEAL_SIDEBAR, () => void reveals.push(1));
});
afterEach(() => {
  offToast?.();
  offReveal?.();
  mounted?.unmount();
  mounted = null;
  store.resetJobModel();
});

describe("stopping a running job", () => {
  it("asks first, and one click is never enough", async () => {
    mounted = render(() => <Jobs />);
    await start(BOOTSTRAP);

    fireEvent.click(screen.getByLabelText("Stop job"));
    // A SIGKILL skips the bootstrap's `|| rm -rf`, so a stray click here is a
    // `.bare` stub on disk. Nothing has been killed yet.
    expect(killed()).toHaveLength(0);
    await screen.findByText(`Stop ${BOOTSTRAP.title}?`);
  });

  it("kills the process once confirmed, and leaves the job on screen", async () => {
    mounted = render(() => <Jobs />);
    await start(BOOTSTRAP);

    fireEvent.click(screen.getByLabelText("Stop job"));
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(killed()).toHaveLength(1));
    expect(killed()[0].args).toEqual({ id: BOOTSTRAP.id });

    // The kill closes the pty, and the exit that follows is what records the
    // outcome. A stopped job says so rather than vanishing like a clean one.
    await exit(BOOTSTRAP.id, 137);
    expect(store.jobs()[0].state).toBe("failed");
  });

  it("kills nothing when the confirm is declined", async () => {
    mounted = render(() => <Jobs />);
    await start(BOOTSTRAP);

    fireEvent.click(screen.getByLabelText("Stop job"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText(`Stop ${BOOTSTRAP.title}?`)).toBeNull());
    expect(killed()).toHaveLength(0);
  });

  it("offers no Stop once the job has already ended", async () => {
    mounted = render(() => <Jobs />);
    await start(BOOTSTRAP);
    await exit(BOOTSTRAP.id, 1);
    await waitFor(() => expect(screen.queryByLabelText("Stop job")).toBeNull());
  });
});

describe("hearing about a job that ended", () => {
  it("reveals the sidebar and the drawer from a failed job's toast", async () => {
    mounted = render(() => <Jobs />);
    await start(BOOTSTRAP);
    store.hideDrawer();

    await exit(BOOTSTRAP.id, 1);
    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0].kind).toBe("error");
    expect(toasts[0].message).toContain("exit 1");

    // The sidebar can be hidden, which would hide the tray with it, so the
    // toast has to reach both surfaces rather than assuming either is up.
    toasts[0].action!.run();
    expect(reveals).toHaveLength(1);
    expect(store.shownJob()?.id).toBe(BOOTSTRAP.id);
  });

  it("says so on an exit it could not confirm, and still offers the way back", async () => {
    mounted = render(() => <Jobs />);
    await start(BOOTSTRAP);
    await exit(BOOTSTRAP.id, null);

    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0].message).toContain("no exit status");
    expect(toasts[0].action).toBeTruthy();
  });

  it("gives a clean run a receipt and no action, because nothing is left to show", async () => {
    mounted = render(() => <Jobs />);
    await start(BOOTSTRAP);
    await exit(BOOTSTRAP.id, 0);

    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0].kind).toBe("info");
    expect(toasts[0].message).toContain("finished");
    expect(toasts[0].action).toBeUndefined();
  });
});

describe("accessibility", () => {
  it("keeps the tray clean under axe, running and exited", async () => {
    mounted = render(() => (
      <>
        <Jobs />
        <JobTray />
      </>
    ));
    await start(BOOTSTRAP);
    await start({ ...BOOTSTRAP, id: "clone:/space/other", title: "clone other" });
    await exit("clone:/space/other", 1);

    await expectNoAxeViolations(mounted.container);
  });

  it("keeps the drawer clean under axe, confirm and all", async () => {
    mounted = render(() => <Jobs />);
    await start(BOOTSTRAP);
    await expectNoAxeViolations(mounted.container);

    // Body-scoped: ConfirmDialog portals out of the container.
    fireEvent.click(screen.getByLabelText("Stop job"));
    await screen.findByText(`Stop ${BOOTSTRAP.title}?`);
    await expectNoAxeViolations(document.body);
  });
});
