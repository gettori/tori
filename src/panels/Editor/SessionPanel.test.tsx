import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "../../test/harness";

// Written for the control migration (#107): "Show reads" is now a `<Switch>`,
// and it had no test at all before, so a migration that left it inert would
// have gone in green. What is pinned is the filter itself, not the control's
// shape - the panel lists what the session touched, and a read-only touch is
// hidden until the toggle asks for it.

let touched: { path: string; op: string; first_ts: number; last_ts: number; count: number }[] = [];
let touchedReply: (() => Promise<unknown>) | null = null;
let touchedReads = 0;
const listeners: Record<string, (() => void)[]> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    switch (cmd) {
      case "session_touched_files":
        touchedReads += 1;
        return touchedReply ? touchedReply() : Promise.resolve(touched);
      default:
        return Promise.resolve([]);
    }
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: () => void) => {
    (listeners[name] ??= []).push(fn);
    return Promise.resolve(() => {});
  },
  emit: () => Promise.resolve(),
}));

import SessionPanel from "./SessionPanel";
import { clearHeld, holdComment } from "../../utils/heldComments";

beforeEach(() => {
  touched = [
    { path: "/proj/written.ts", op: "write", first_ts: 1, last_ts: 2, count: 1 },
    { path: "/proj/read-only.ts", op: "read", first_ts: 1, last_ts: 2, count: 1 },
  ];
  touchedReply = null;
  touchedReads = 0;
  for (const key of Object.keys(listeners)) delete listeners[key];
});

function hold() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
}

function open() {
  return render(() => (
    <SessionPanel
      path="/proj/.session"
      agent="claude"
      profile={null}
      cwd="/proj"
      projectRoot="/proj"
      selfSessionId="s1"
      liveTabs={[]}
      heldKey="/proj"
    />
  ));
}

describe("SessionPanel: Show reads", () => {
  it("hides read-only touches until the toggle asks for them", async () => {
    open();
    await waitFor(() => expect(screen.getByText(/written\.ts/)).toBeTruthy());
    expect(screen.queryByText(/read-only\.ts/)).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: /show reads/i }));

    await waitFor(() => expect(screen.getByText(/read-only\.ts/)).toBeTruthy());
    // The write never disappears: the toggle widens the list, it does not swap it.
    expect(screen.getByText(/written\.ts/)).toBeTruthy();
  });

  it("hides them again when the toggle goes back off", async () => {
    open();
    await waitFor(() => expect(screen.getByText(/written\.ts/)).toBeTruthy());
    const toggle = screen.getByRole("switch", { name: /show reads/i });

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText(/read-only\.ts/)).toBeTruthy());

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByText(/read-only\.ts/)).toBeNull());
  });
});

describe("SessionPanel: held comments", () => {
  afterEach(() => clearHeld("/proj"));

  it("shows the workspace's held comments, ready to send to this session", async () => {
    holdComment("/proj", { path: "/proj/written.ts", startLine: 1, endLine: 2, text: "why" });
    open();
    fireEvent.click(screen.getByRole("button", { name: "1 comment" }));
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("SessionPanel: reading what the session touched", () => {
  it("says it is reading until the list lands, rather than that nothing was edited", async () => {
    const read = hold();
    touchedReply = () => read.promise;
    open();
    expect(await screen.findByText("Reading what this session touched...")).toBeTruthy();
    expect(screen.queryByText(/Nothing edited yet/)).toBeNull();
    expect(screen.getByRole("switch", { name: /show reads/i })).toBeTruthy();

    read.resolve(touched);
    expect(await screen.findByText(/written\.ts/)).toBeTruthy();
    expect(screen.queryByText("Reading what this session touched...")).toBeNull();
  });

  it("keeps the rows up while a finished turn reads the list again", async () => {
    open();
    await screen.findByText(/written\.ts/);
    await waitFor(() => expect(listeners["sessions://changed"]?.length).toBe(1));

    const again = hold();
    touchedReply = () => again.promise;
    listeners["sessions://changed"][0]();
    await waitFor(() => expect(touchedReads).toBe(2));
    expect(screen.getByText(/written\.ts/)).toBeTruthy();
    expect(screen.queryByText("Reading what this session touched...")).toBeNull();

    again.resolve([...touched, { path: "/proj/new.ts", op: "create", first_ts: 3, last_ts: 3, count: 1 }]);
    expect(await screen.findByText(/new\.ts/)).toBeTruthy();
  });

  it("says the transcript could not be read instead of that nothing was edited, and tries again", async () => {
    touchedReply = () => Promise.reject("transcript missing");
    open();
    expect(await screen.findByText(/could not be read: transcript missing/)).toBeTruthy();
    expect(screen.queryByText(/Nothing edited yet/)).toBeNull();

    touchedReply = null;
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText(/written\.ts/)).toBeTruthy();
  });
});
