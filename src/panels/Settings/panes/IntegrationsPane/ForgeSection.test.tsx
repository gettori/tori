import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@solidjs/testing-library";
import type { AuthState, ForgeAccount, ForgeHost, SignInRoutes } from "../../../../utils/forgeTypes";

// The surfaces the forge accounts section has to tell apart, driven through the
// real component.
//
// The one worth the most attention is **suspect**. It is not signed-out: the
// token is still in the keychain, so the copy and the action are different, and
// rendering it as signed-out would tell the user their credential was discarded
// when it deliberately was not.

let hosts: ForgeHost[] = [];
let devicePolls: unknown[] = [];
const calls = { start: 0, poll: 0, cancel: 0, removed: [] as string[] };

function account(id: string, auth: AuthState, login: string | null): ForgeAccount {
  return { id, provider: "github", baseUrl: "https://github.com", login, label: login ?? "", expiresAt: null, auth };
}

/** Rust's ladder, reduced to the one fact these tests branch on. */
function routesFor(baseUrl: string): SignInRoutes {
  const host = new URL(baseUrl).host;
  return {
    host,
    baseUrl,
    deviceFlow: host === "github.com",
    scopes: ["repo"],
    tokenUrl: `${baseUrl}/settings/tokens/new?scopes=repo`,
  };
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "forge_accounts":
        return Promise.resolve(hosts);
      case "forge_sign_in_routes":
        return Promise.resolve(routesFor(args?.baseUrl as string));
      case "forge_device_start":
        calls.start += 1;
        return Promise.resolve({
          userCode: "WDJB-MJHT",
          verificationUri: "https://github.com/login/device",
          expiresInSecs: 900,
          intervalSecs: 5,
        });
      case "forge_device_poll": {
        calls.poll += 1;
        const next = devicePolls.shift();
        return next === undefined ? Promise.resolve({ kind: "pending", nextIntervalSecs: 5 }) : Promise.resolve(next);
      }
      case "forge_device_cancel":
        calls.cancel += 1;
        return Promise.resolve(null);
      case "forge_remove_account":
        calls.removed.push(args?.accountId as string);
        hosts = [];
        return Promise.resolve(null);
      case "get_settings":
      case "set_settings":
        return Promise.resolve({});
      default:
        return Promise.resolve(null);
    }
  },
}));

vi.mock("../../../../utils/clipboard", () => ({ copyText: () => Promise.resolve(true) }));

import ForgeSection from "./ForgeSection";

beforeEach(() => {
  cleanup();
  hosts = [];
  devicePolls = [];
  calls.start = 0;
  calls.poll = 0;
  calls.cancel = 0;
  calls.removed = [];
  vi.stubGlobal("open", vi.fn());
});

/** Opens the add form on its github.com default and starts the browser flow. */
async function startBrowserSignIn() {
  fireEvent.click(await screen.findByText("Add account"));
  fireEvent.click(await screen.findByText("Continue"));
  fireEvent.click(await screen.findByText("Sign in with browser"));
}

describe("the forge accounts settings section", () => {
  it("offers adding an account when there is none", async () => {
    render(() => <ForgeSection />);
    expect(await screen.findByText("No accounts")).toBeTruthy();
    expect(screen.getByText("Add account")).toBeTruthy();
  });

  it("lists two signed-in users on one host as two accounts under it", async () => {
    hosts = [
      {
        host: "github.com",
        accounts: [
          account("github-com-skarif2", { kind: "signedIn", login: "skarif2" }, "skarif2"),
          account("github-com-fonn-arif", { kind: "signedIn", login: "fonn-arif" }, "fonn-arif"),
        ],
      },
    ];
    render(() => <ForgeSection />);
    expect(await screen.findAllByTestId("forge-account")).toHaveLength(2);
    expect(screen.getByText("github.com")).toBeTruthy();
    expect(screen.getByText(/Signed in as fonn-arif/)).toBeTruthy();
  });

  it("renders a suspect credential as sign-in-again, not as signed out", async () => {
    // The distinction the whole 401 story rests on. A signed-out rendering here
    // would say the token was thrown away, and Sway keeps it precisely so a
    // transient rejection costs nothing.
    hosts = [
      {
        host: "github.com",
        accounts: [account("github-com-skarif2", { kind: "suspect", login: "skarif2" }, "skarif2")],
      },
    ];
    render(() => <ForgeSection />);

    const notice = await screen.findByTestId("suspect-notice");
    expect(notice.textContent).toContain("rejected the stored sign-in");
    expect(screen.getByText("skarif2")).toBeTruthy();
    expect(screen.getByText("Sign in again")).toBeTruthy();
    expect(screen.queryByText("No accounts")).toBeNull();
  });

  it("removes an account through Rust", async () => {
    hosts = [
      {
        host: "github.com",
        accounts: [account("github-com-skarif2", { kind: "signedIn", login: "skarif2" }, "skarif2")],
      },
    ];
    render(() => <ForgeSection />);
    fireEvent.click(await screen.findByLabelText("Remove skarif2"));
    await waitFor(() => expect(calls.removed).toEqual(["github-com-skarif2"]));
    expect(await screen.findByText("No accounts")).toBeTruthy();
  });

  it("offers the browser on github.com and names the scope a token needs", async () => {
    render(() => <ForgeSection />);
    fireEvent.click(await screen.findByText("Add account"));
    fireEvent.click(await screen.findByText("Continue"));

    expect(await screen.findByText("Sign in with browser")).toBeTruthy();
    expect(screen.getByTestId("token-scopes").textContent).toContain("repo scope");
  });

  it("offers only a token on a host Sway has no browser sign-in for", async () => {
    render(() => <ForgeSection />);
    fireEvent.click(await screen.findByText("Add account"));
    fireEvent.input(screen.getByLabelText("Host URL"), { target: { value: "https://git.example.com" } });
    fireEvent.click(screen.getByText("Continue"));

    expect((await screen.findByTestId("token-scopes")).textContent).toContain("git.example.com");
    expect(screen.queryByText("Sign in with browser")).toBeNull();
  });

  it("shows the code and the page to type it into while a flow is pending", async () => {
    render(() => <ForgeSection />);
    await startBrowserSignIn();

    // The code is useless without the page, so the flow opens it rather than
    // leaving the user to find it.
    expect((await screen.findByTestId("device-code")).textContent).toBe("WDJB-MJHT");
    await waitFor(() => expect(window.open).toHaveBeenCalledWith("https://github.com/login/device", "_blank"));
  });

  it("reports a declined sign-in and stops polling", async () => {
    devicePolls = [{ kind: "denied" }];
    vi.useFakeTimers();
    render(() => <ForgeSection />);
    await startBrowserSignIn();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(screen.getByTestId("forge-error").textContent).toContain("declined");
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
    render(() => <ForgeSection />);
    await startBrowserSignIn();

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
    const { unmount } = render(() => <ForgeSection />);
    await startBrowserSignIn();
    await screen.findByTestId("device-code");

    unmount();
    await waitFor(() => expect(calls.cancel).toBe(1));
  });
});
