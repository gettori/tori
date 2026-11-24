import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "../../../src/test/harness";
import { ConnectionRow, ShortcutRow } from "./rows";

let answer: () => Promise<string | null> = async () => null;
const sendMessage = vi.fn(() => answer());
let commands: () => Promise<{ name: string; shortcut?: string }[]> = async () => [];
vi.stubGlobal("chrome", { runtime: { sendMessage }, commands: { getAll: () => commands() } });

const status = () => screen.getByRole("status").textContent;
const checkAgain = () => screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement;

function hold() {
  let resolve!: (value: string | null) => void;
  const promise = new Promise<string | null>((yes) => (resolve = yes));
  return { promise, resolve };
}

beforeEach(() => {
  sendMessage.mockClear();
  answer = async () => null;
  commands = async () => [];
});

describe("the options page's Connection row", () => {
  it("says it is asking Tori until the worker answers", async () => {
    const first = hold();
    answer = () => first.promise;
    render(() => <ConnectionRow />);
    expect(status()).toBe("Asking Tori.");

    first.resolve(null);
    await waitFor(() => expect(status()).toBe("Tori is running and set up for this browser."));
  });

  it("keeps the last answer, with Check again held, while it asks again", async () => {
    render(() => <ConnectionRow />);
    await waitFor(() => expect(status()).toBe("Tori is running and set up for this browser."));

    const again = hold();
    answer = () => again.promise;
    fireEvent.click(checkAgain());
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(checkAgain().disabled).toBe(true);
    expect(status()).toBe("Tori is running and set up for this browser.");

    again.resolve("Tori is not running.");
    await waitFor(() => expect(status()).toBe("Tori is not running."));
    expect(checkAgain().disabled).toBe(false);
  });

  it("says the worker could not be asked, and Check again asks it again", async () => {
    answer = () => Promise.reject(new Error("Receiving end does not exist."));
    render(() => <ConnectionRow />);
    await waitFor(() => expect(status()).toContain("Receiving end does not exist."));

    answer = async () => null;
    fireEvent.click(checkAgain());
    await waitFor(() => expect(status()).toBe("Tori is running and set up for this browser."));
  });
});

describe("the options page's Shortcut row", () => {
  it("says it is checking until Chrome answers, then shows the keys", async () => {
    let land!: (value: { name: string; shortcut?: string }[]) => void;
    commands = () => new Promise((yes) => (land = yes));
    render(() => <ShortcutRow />);
    expect(screen.getByText("Checking")).toBeTruthy();
    expect(screen.queryByText("Not set")).toBeNull();

    land([{ name: "pick", shortcut: "Alt+P" }]);
    await waitFor(() => expect(document.querySelector("kbd")).not.toBeNull());
  });

  it("says Not set when the command has no shortcut", async () => {
    commands = async () => [{ name: "pick" }];
    render(() => <ShortcutRow />);
    expect(await screen.findByText("Not set")).toBeTruthy();
  });

  it("says Unknown, not Not set, when Chrome cannot be asked", async () => {
    commands = () => Promise.reject(new Error("commands API missing"));
    render(() => <ShortcutRow />);
    expect(await screen.findByText("Unknown, Error: commands API missing")).toBeTruthy();
    expect(screen.queryByText("Not set")).toBeNull();
  });
});
