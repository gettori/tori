import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { invoke } from "@tauri-apps/api/core";
import { render, screen, waitFor } from "../../test/harness";
import { CHECK_UPDATES, emit } from "../../utils/events";
import UpdatePill from "./UpdatePill";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "26.1100.0" }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
const invoked = vi.mocked(invoke);

type UpdateInfo = { version: string; blocked: string | null };
let atLaunch: () => Promise<UpdateInfo | null> = async () => null;
let asked: () => Promise<unknown> = async () => ({ state: "current" });

function hold() {
  let resolve!: (value: UpdateInfo | null) => void;
  const promise = new Promise<UpdateInfo | null>((yes) => (resolve = yes));
  return { promise, resolve };
}

const pill = () => screen.queryByRole("button", { name: /Show update details/ });

beforeEach(() => {
  invoked.mockReset();
  atLaunch = async () => null;
  asked = async () => ({ state: "current" });
  invoked.mockImplementation(async (cmd) => {
    if (cmd === "check_for_update") return atLaunch();
    if (cmd === "check_for_update_now") return asked();
    return null;
  });
});

describe("the update pill", () => {
  it("shows nothing while the launch check runs, then names the newer build", async () => {
    const check = hold();
    atLaunch = () => check.promise;
    render(() => <UpdatePill />);
    await waitFor(() => expect(invoked).toHaveBeenCalledWith("check_for_update"));
    expect(pill()).toBeNull();

    check.resolve({ version: "26.1200.0", blocked: null });
    await waitFor(() => expect(pill()?.textContent).toBe("Update available 26.1200.0"));
  });

  it("keeps the pill while a manual check runs, and takes the newer answer", async () => {
    atLaunch = async () => ({ version: "26.1200.0", blocked: null });
    let answer!: (value: unknown) => void;
    asked = () => new Promise((yes) => (answer = yes));
    render(() => <UpdatePill />);
    await waitFor(() => expect(pill()).not.toBeNull());

    emit(CHECK_UPDATES);
    await waitFor(() => expect(invoked).toHaveBeenCalledWith("check_for_update_now"));
    expect(pill()?.textContent).toBe("Update available 26.1200.0");

    answer({ state: "newer", version: "26.1300.0", blocked: null });
    await waitFor(() => expect(pill()?.textContent).toBe("Update available 26.1300.0"));
  });

  it("shows no pill when the launch check fails", async () => {
    atLaunch = () => Promise.reject("offline");
    render(() => <UpdatePill />);
    await waitFor(() => expect(invoked).toHaveBeenCalledWith("check_for_update"));
    await Promise.resolve();
    expect(pill()).toBeNull();
  });
});
