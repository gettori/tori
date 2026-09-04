import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

// Written for the control migration (#107): "Show reads" is now a `<Switch>`,
// and it had no test at all before, so a migration that left it inert would
// have gone in green. What is pinned is the filter itself, not the control's
// shape - the panel lists what the session touched, and a read-only touch is
// hidden until the toggle asks for it.

let touched: { path: string; op: string; first_ts: number; last_ts: number; count: number }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    switch (cmd) {
      case "session_touched_files":
        return Promise.resolve(touched);
      default:
        return Promise.resolve([]);
    }
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));

import SessionPanel from "./SessionPanel";

beforeEach(() => {
  touched = [
    { path: "/proj/written.ts", op: "write", first_ts: 1, last_ts: 2, count: 1 },
    { path: "/proj/read-only.ts", op: "read", first_ts: 1, last_ts: 2, count: 1 },
  ];
});

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
