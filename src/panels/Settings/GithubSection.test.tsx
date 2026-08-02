import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@solidjs/testing-library";
import type { AuthState } from "../../utils/forgeTypes";

// The four surfaces the GitHub section has to tell apart, driven through the
// real component.
//
// The one worth the most attention is **suspect**. It is not signed-out: the
// token is still in the keychain, so the copy and the action are different, and
// rendering it as signed-out would tell the user their credential was discarded
// when it deliberately was not.

let authState: AuthState = { kind: "signedOut" };
let configured = true;
let devicePolls: unknown[] = [];
const calls = { start: 0, poll: 0, signOut: 0, cancel: 0 };

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    switch (cmd) {
      case "github_auth_state":
        return Promise.resolve(authState);
      case "github_is_configured":
        return Promise.resolve(configured);
      case "github_device_start":
        calls.start += 1;
        return Promise.resolve({
          userCode: "WDJB-MJHT",
          verificationUri: "https://github.com/login/device",
          expiresInSecs: 900,
          intervalSecs: 5,
        });
      case "github_device_poll": {
        calls.poll += 1;
        const next = devicePolls.shift();
        return next === undefined ? Promise.resolve({ kind: "pending", nextIntervalSecs: 5 }) : Promise.resolve(next);
      }
      case "github_device_cancel":
        calls.cancel += 1;
        return Promise.resolve(null);
      case "github_sign_out":
        calls.signOut += 1;
        authState = { kind: "signedOut" };
        return Promise.resolve(null);
      case "get_settings":
      case "set_settings":
        return Promise.resolve({});
      default:
        return Promise.resolve(null);
    }
  },
}));

vi.mock("../../utils/clipboard", () => ({ copyText: () => Promise.resolve(true) }));

import GithubSection from "./GithubSection";

beforeEach(() => {
  cleanup();
  authState = { kind: "signedOut" };
  configured = true;
  devicePolls = [];
  calls.start = 0;
  calls.poll = 0;
  calls.signOut = 0;
  calls.cancel = 0;
  vi.stubGlobal("open", vi.fn());
});

describe("the GitHub settings section", () => {
  it("offers sign-in when signed out", async () => {
    render(() => <GithubSection />);
    expect(await screen.findByText("Sign in to GitHub")).toBeTruthy();
  });

  it("shows the code and the page to type it into while a flow is pending", async () => {
    render(() => <GithubSection />);
    fireEvent.click(await screen.findByText("Sign in to GitHub"));

    // The code is useless without the page, so the flow opens it rather than
    // leaving the user to find it.
    expect((await screen.findByTestId("device-code")).textContent).toBe("WDJB-MJHT");
    await waitFor(() => expect(window.open).toHaveBeenCalledWith("https://github.com/login/device", "_blank"));
  });

  it("names the account when signed in and offers sign out", async () => {
    authState = { kind: "signedIn", login: "skarif2" };
    render(() => <GithubSection />);
    expect(await screen.findByText(/Signed in as skarif2/)).toBeTruthy();

    fireEvent.click(screen.getByText("Sign out"));
    await waitFor(() => expect(calls.signOut).toBe(1));
  });

  it("renders a suspect credential as sign-in-again, not as signed out", async () => {
    // The distinction the whole 401 story rests on. A signed-out rendering here
    // would say the token was thrown away, and Sway keeps it precisely so a
    // transient rejection costs nothing.
    authState = { kind: "suspect", login: "skarif2" };
    render(() => <GithubSection />);

    const notice = await screen.findByTestId("suspect-notice");
    expect(notice.textContent).toContain("rejected the stored sign-in");
    expect(notice.textContent).toContain("skarif2");
    expect(screen.getByText("Sign in again")).toBeTruthy();
    // And emphatically not the signed-out control.
    expect(screen.queryByText("Sign in to GitHub")).toBeNull();
  });

  it("says so when the build has no OAuth app rather than offering a dead button", async () => {
    // Until the app is registered, a sign-in button could only fail. Offering
    // it anyway is the dead-control failure.
    configured = false;
    render(() => <GithubSection />);
    expect(await screen.findByText(/no OAuth app is configured/)).toBeTruthy();
    expect(screen.queryByText("Sign in to GitHub")).toBeNull();
  });

  it("reports a declined sign-in and stops polling", async () => {
    devicePolls = [{ kind: "denied" }];
    vi.useFakeTimers();
    render(() => <GithubSection />);
    fireEvent.click(await screen.findByText("Sign in to GitHub"));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(screen.getByTestId("github-error").textContent).toContain("declined");
    const pollsAfterDenial = calls.poll;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.poll, "a declined flow must stop polling").toBe(pollsAfterDenial);
    vi.useRealTimers();
  });

  it("waits the interval the server asks for, so a slow_down actually slows it", async () => {
    // The backoff is only real if the caller honours it. A fixed interval here
    // would note the slow_down and keep the same pace, which is how a throttle
    // becomes a block.
    devicePolls = [{ kind: "pending", nextIntervalSecs: 30 }];
    vi.useFakeTimers();
    render(() => <GithubSection />);
    fireEvent.click(await screen.findByText("Sign in to GitHub"));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.poll).toBe(1);

    // Still inside the 30s the server asked for.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.poll).toBe(1);

    await vi.advanceTimersByTimeAsync(21_000);
    expect(calls.poll).toBe(2);
    vi.useRealTimers();
  });

  it("cancels an in-flight flow when the panel goes away", async () => {
    // A device flow left running would keep hitting GitHub after Settings
    // closed, which on a slow_down is exactly how a throttle becomes a block.
    const { unmount } = render(() => <GithubSection />);
    fireEvent.click(await screen.findByText("Sign in to GitHub"));
    await screen.findByTestId("device-code");

    unmount();
    await waitFor(() => expect(calls.cancel).toBe(1));
  });
});
