import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { invoke } from "@tauri-apps/api/core";
import { render, screen, fireEvent, waitFor } from "../../test/harness";
import TrustSection from "./TrustSection";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
const invoked = vi.mocked(invoke);

let trusted: () => Promise<string[]> = async () => [];
const reads = () => invoked.mock.calls.filter(([cmd]) => cmd === "trusted_projects").length;

function hold() {
  let resolve!: (value: string[]) => void;
  const promise = new Promise<string[]>((yes) => (resolve = yes));
  return { promise, resolve };
}

beforeEach(() => {
  invoked.mockReset();
  trusted = async () => [];
  invoked.mockImplementation(async (cmd) => (cmd === "trusted_projects" ? trusted() : null));
});

describe("the project's Trust section", () => {
  it("claims nothing until the trusted list lands", async () => {
    const list = hold();
    trusted = () => list.promise;
    render(() => <TrustSection projectPath="/s/app" />);
    await waitFor(() => expect(reads()).toBe(1));
    expect(screen.queryByText("Not trusted")).toBeNull();
    expect(screen.queryByText("Trusted")).toBeNull();

    list.resolve(["/s/app"]);
    expect(await screen.findByRole("button", { name: "Revoke" })).toBeTruthy();
  });

  it("keeps what it says while Trust reads the list again", async () => {
    render(() => <TrustSection projectPath="/s/app" />);
    expect(await screen.findByText("Not trusted")).toBeTruthy();

    const again = hold();
    trusted = () => again.promise;
    fireEvent.click(screen.getByRole("button", { name: "Trust" }));
    await waitFor(() => expect(reads()).toBe(2));
    expect(screen.getByText("Not trusted")).toBeTruthy();

    again.resolve(["/s/app"]);
    expect(await screen.findByRole("button", { name: "Revoke" })).toBeTruthy();
  });

  it("says the list could not be read instead of calling the project untrusted, and tries again", async () => {
    trusted = () => Promise.reject("trust file is locked");
    render(() => <TrustSection projectPath="/s/app" />);
    expect(await screen.findByText(/The trusted list could not be read: trust file is locked/)).toBeTruthy();
    expect(screen.queryByText("Not trusted")).toBeNull();

    trusted = async () => ["/s/app"];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Revoke" })).toBeTruthy();
  });
});
