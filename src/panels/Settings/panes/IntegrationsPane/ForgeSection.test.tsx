import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@solidjs/testing-library";
import { pointerClick } from "../../../../test/menus";
import type {
  AuthState,
  ForgeAccount,
  ForgeHost,
  ForgeProvider,
  SignInRoutes,
} from "../../../../utils/forgeTypes";

// The surfaces the forge accounts section has to tell apart, driven through the
// real component.
//
// The one worth the most attention is **suspect**. It is not signed-out: the
// token is still in the keychain, so the copy and the action are different, and
// rendering it as signed-out would tell the user their credential was discarded
// when it deliberately was not.

let hosts: ForgeHost[] = [];
/** The application id Rust has stored per host, which is what turns the browser
 *  flow on for a GitLab instance. */
let appIds: Record<string, string> = {};
/** Which hosts answer git, the switch Rust keeps on the host record. */
let gitCredentials: Record<string, boolean> = {};
let devicePolls: unknown[] = [];
const calls = {
  start: 0,
  poll: 0,
  cancel: 0,
  removed: [] as string[],
  gitCredentials: [] as [string, boolean][],
  defaults: [] as [string, string | null][],
  resets: 0,
};

function account(id: string, auth: AuthState, login: string | null, extra: Partial<ForgeAccount> = {}): ForgeAccount {
  return { id, provider: "github", baseUrl: "https://github.com", login, label: login ?? "", expiresAt: null, rejectedAt: null, auth, ...extra };
}

function hostOf(host: string, accounts: ForgeAccount[], extra: Partial<ForgeHost> = {}): ForgeHost {
  return { host, accounts, gitCredentials: false, defaultAccount: null, ...extra };
}

const on = (login: string) => account(`github-com-${login}`, { kind: "signedIn", login }, login);
const rejected = (login: string, rejectedAt: number | null) =>
  account(`github-com-${login}`, { kind: "suspect", login }, login, { rejectedAt });

/** Rust's ladder, reduced to the facts these tests branch on: Sway's own
 *  application covers github.com, and a GitLab instance has whichever one was
 *  registered on it. */
function routesFor(baseUrl: string, provider: ForgeProvider = "github"): SignInRoutes {
  const host = new URL(baseUrl).host;
  const appId = appIds[host] ?? null;
  // Rust's other rule: GitHub's `repo` already carries push, while GitLab needs
  // the git scope named separately once the host answers git.
  const scopes =
    provider === "gitlab" ? (gitCredentials[host] ? ["api", "write_repository"] : ["api"]) : ["repo"];
  return {
    host,
    baseUrl,
    deviceFlow: host === "github.com" || appId !== null,
    scopes,
    tokenUrl: `${baseUrl}/settings/tokens/new?scopes=${scopes.join(",")}`,
    appId,
  };
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "forge_accounts":
        return Promise.resolve(hosts);
      case "forge_sign_in_routes":
        return Promise.resolve(routesFor(args?.baseUrl as string, args?.provider as ForgeProvider));
      case "forge_set_app_id": {
        const url = args?.baseUrl as string;
        const id = (args?.appId as string).trim();
        const host = new URL(url).host;
        if (id) appIds[host] = id;
        else delete appIds[host];
        return Promise.resolve(routesFor(url, args?.provider as ForgeProvider));
      }
      case "forge_set_git_credentials": {
        const host = args?.host as string;
        const enabled = args?.enabled as boolean;
        calls.gitCredentials.push([host, enabled]);
        gitCredentials[host] = enabled;
        hosts = hosts.map((h) => (h.host === host ? { ...h, gitCredentials: enabled } : h));
        return Promise.resolve(hosts);
      }
      case "forge_set_default_account": {
        const host = args?.host as string;
        const accountId = (args?.accountId as string | null) ?? null;
        calls.defaults.push([host, accountId]);
        hosts = hosts.map((h) => (h.host === host ? { ...h, defaultAccount: accountId } : h));
        return Promise.resolve(hosts);
      }
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
vi.mock("../../../../utils/forgeStatus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../utils/forgeStatus")>()),
  resetForgeResolutions: () => {
    calls.resets += 1;
  },
}));

import ForgeSection from "./ForgeSection";

beforeEach(() => {
  cleanup();
  hosts = [];
  appIds = {};
  gitCredentials = {};
  devicePolls = [];
  calls.start = 0;
  calls.poll = 0;
  calls.cancel = 0;
  calls.removed = [];
  calls.gitCredentials = [];
  calls.defaults = [];
  calls.resets = 0;
  vi.stubGlobal("open", vi.fn());
});

/** Opens the add form on its github.com default and starts the browser flow. */
async function startBrowserSignIn() {
  fireEvent.click(await screen.findByText("Connect github.com"));
  fireEvent.click(await screen.findByText("Continue"));
  fireEvent.click(await screen.findByText("Sign in with browser"));
}

describe("the forge accounts settings section", () => {
  it("offers connecting github.com, with the global switch inert, when there is no host", async () => {
    render(() => <ForgeSection />);
    expect(await screen.findByText("No hosts connected")).toBeTruthy();
    expect(screen.getByText("Connect github.com")).toBeTruthy();
    expect(screen.getByText("Another host...")).toBeTruthy();
    expect(screen.getByText("Available once a host is connected.")).toBeTruthy();
    expect((screen.getByLabelText("Show pull requests and checks") as HTMLInputElement).disabled).toBe(true);
  });

  it("gives one github.com account a card with its tag, status and one account's switch", async () => {
    hosts = [hostOf("github.com", [on("octocat")])];
    render(() => <ForgeSection />);
    const card = await screen.findByTestId("forge-host");
    expect(card.textContent).toContain("GitHub");
    expect(card.textContent).toContain("signed in");
    expect(card.textContent).toContain("Use this account for git push and fetch");
    expect(screen.getByText("Connect another host...")).toBeTruthy();
    expect((screen.getByLabelText("Show pull requests and checks") as HTMLInputElement).disabled).toBe(false);
  });

  it("lists two accounts under github.com and one under gitlab.com, each card tagged by family", async () => {
    hosts = [
      hostOf("github.com", [on("octocat"), on("octocat-review")], { gitCredentials: true, defaultAccount: "github-com-octocat" }),
      hostOf("gitlab.com", [
        account("gitlab-com-a-mehta", { kind: "signedIn", login: "a.mehta" }, "a.mehta", {
          provider: "gitlab",
          baseUrl: "https://gitlab.com",
        }),
      ]),
    ];
    render(() => <ForgeSection />);
    const [github, gitlab] = await screen.findAllByTestId("forge-host");
    expect(within(github).getAllByTestId("forge-account")).toHaveLength(2);
    expect(github.textContent).toContain("GitHub");
    expect(github.textContent).toContain("Use for git push and fetch");
    expect(screen.getByLabelText("Account github.com pushes and fetches as").textContent).toContain("octocat");
    expect(gitlab.textContent).toContain("GitLab");
    expect(gitlab.textContent).toContain("Use this account for git push and fetch");
  });

  it("washes a rejected Enterprise account with the date the host stopped accepting it", async () => {
    // Noon UTC, so the day reads the same in every timezone the suite runs in.
    hosts = [
      hostOf("ghe.example.com", [
        account("ghe-example-com-j-okafor", { kind: "suspect", login: "j.okafor" }, "j.okafor", {
          baseUrl: "https://ghe.example.com",
          rejectedAt: Date.UTC(2025, 8, 12, 12) / 1000,
        }),
      ]),
    ];
    render(() => <ForgeSection />);
    const card = await screen.findByTestId("forge-host");
    expect(card.textContent).toContain("Enterprise");
    expect(card.textContent).toContain("rejected");
    expect(screen.getByTestId("suspect-notice").textContent).toBe(
      "ghe.example.com stopped accepting this token on 12 Sep. It is still stored, so signing in again replaces it in place.",
    );
    expect(screen.getByText("Sign in again")).toBeTruthy();
    expect(screen.queryByText("No hosts connected")).toBeNull();
  });

  it("leaves the date out of the rejection when Sway never recorded one", async () => {
    hosts = [hostOf("github.com", [rejected("skarif2", null)])];
    render(() => <ForgeSection />);
    expect((await screen.findByTestId("suspect-notice")).textContent).toBe(
      "github.com stopped accepting this token. It is still stored, so signing in again replaces it in place.",
    );
  });

  it("offers only signed-in accounts in the chip, with a placeholder until one is chosen", async () => {
    hosts = [hostOf("github.com", [on("a"), rejected("b", null), on("c")])];
    render(() => <ForgeSection />);
    const chip = await screen.findByLabelText("Account github.com pushes and fetches as");
    expect(chip.textContent).toContain("Choose account");

    pointerClick(chip);
    await screen.findByRole("listbox");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["a", "c"]);
  });

  it("stores a chosen account as the host default and asks every repo again", async () => {
    hosts = [hostOf("github.com", [on("a"), on("c")])];
    render(() => <ForgeSection />);
    pointerClick(await screen.findByLabelText("Account github.com pushes and fetches as"));
    await screen.findByRole("listbox");
    pointerClick(screen.getByRole("option", { name: "c" }));

    await waitFor(() => expect(calls.defaults).toEqual([["github.com", "github-com-c"]]));
    await waitFor(() => expect(calls.resets).toBe(1));
  });

  it("makes the first signed-in account the default when the switch goes on without one", async () => {
    // Otherwise the switch would read on while git still asked which account.
    hosts = [hostOf("github.com", [rejected("a", null), on("b"), on("c")])];
    render(() => <ForgeSection />);
    fireEvent.click(await screen.findByLabelText("Use github.com for git push and fetch"));

    await waitFor(() => expect(calls.gitCredentials).toEqual([["github.com", true]]));
    expect(calls.defaults).toEqual([["github.com", "github-com-b"]]);
    expect(calls.resets).toBe(1);
  });

  it("renders the footer inert when every account on the host is rejected", async () => {
    hosts = [hostOf("github.com", [rejected("a", null), rejected("b", null)])];
    render(() => <ForgeSection />);
    const toggle = (await screen.findByLabelText("Use github.com for git push and fetch")) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect((screen.getByLabelText("Account github.com pushes and fetches as") as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks before removing an account, and removes nothing on cancel", async () => {
    hosts = [hostOf("github.com", [on("skarif2")])];
    render(() => <ForgeSection />);
    fireEvent.click(await screen.findByLabelText("Remove skarif2"));
    expect(await screen.findByText("Remove skarif2 from github.com?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Remove skarif2 from github.com?")).toBeNull());
    expect(calls.removed).toEqual([]);
  });

  it("removes an account through Rust once confirmed", async () => {
    hosts = [hostOf("github.com", [on("skarif2")])];
    render(() => <ForgeSection />);
    fireEvent.click(await screen.findByLabelText("Remove skarif2"));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(calls.removed).toEqual(["github-com-skarif2"]));
    expect(await screen.findByText("No hosts connected")).toBeTruthy();
  });

  it("offers the browser on github.com and names the scope a token needs", async () => {
    render(() => <ForgeSection />);
    fireEvent.click(await screen.findByText("Connect github.com"));
    fireEvent.click(await screen.findByText("Continue"));

    expect(await screen.findByText("Sign in with browser")).toBeTruthy();
    expect(screen.getByTestId("token-scopes").textContent).toContain("repo scope");
  });

  it("offers only a token on a host Sway has no browser sign-in for", async () => {
    render(() => <ForgeSection />);
    fireEvent.click(await screen.findByText("Another host..."));
    fireEvent.input(screen.getByLabelText("Host URL"), { target: { value: "https://git.example.com" } });
    fireEvent.click(screen.getByText("Continue"));

    expect((await screen.findByTestId("token-scopes")).textContent).toContain("git.example.com");
    expect(screen.queryByText("Sign in with browser")).toBeNull();
  });

  it("offers a self-managed GitLab the browser only once it has an application id", async () => {
    // Only that instance's admin can register an application, so until its id
    // is known the browser flow would open a page the server refuses.
    render(() => <ForgeSection />);
    fireEvent.click(await screen.findByText("Another host..."));
    // The provider picker is a listbox behind a button, so a choice is two
    // presses and the rows exist only while it is open.
    pointerClick(screen.getByLabelText("Provider"));
    await screen.findByRole("listbox");
    pointerClick(screen.getByRole("option", { name: "GitLab" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    fireEvent.input(screen.getByLabelText("Host URL"), {
      target: { value: "https://git.example.com" },
    });
    fireEvent.click(screen.getByText("Continue"));

    expect((await screen.findByTestId("token-scopes")).textContent).toContain("git.example.com");
    expect(screen.queryByText("Sign in with browser")).toBeNull();

    fireEvent.input(screen.getByLabelText("Application ID"), { target: { value: "app-123" } });
    fireEvent.click(screen.getByText("Save"));

    expect(await screen.findByText("Sign in with browser")).toBeTruthy();
  });

  it("hands git this host's account once the switch is on", async () => {
    hosts = [
      {
        host: "github.com",
        accounts: [account("github-com-skarif2", { kind: "signedIn", login: "skarif2" }, "skarif2")],
        gitCredentials: false,
        defaultAccount: null,
      },
    ];
    render(() => <ForgeSection />);
    fireEvent.click(await screen.findByLabelText("Use github.com for git push and fetch"));
    await waitFor(() => expect(calls.gitCredentials).toEqual([["github.com", true]]));
  });

  it("names the git scope on a GitLab host that answers git", async () => {
    // `api` alone cannot push, so a token pasted for a host with the switch on
    // would sign in and then fail on the first push.
    hosts = [
      {
        host: "git.example.com",
        accounts: [
          {
            id: "git-example-com-arif",
            provider: "gitlab",
            baseUrl: "https://git.example.com",
            login: "arif",
            label: "arif",
            expiresAt: null,
            rejectedAt: null,
            auth: { kind: "signedIn", login: "arif" },
          },
        ],
        gitCredentials: true,
        defaultAccount: null,
      },
    ];
    gitCredentials["git.example.com"] = true;
    render(() => <ForgeSection />);

    fireEvent.click(await screen.findByText("Add account"));
    pointerClick(screen.getByLabelText("Provider"));
    await screen.findByRole("listbox");
    pointerClick(screen.getByRole("option", { name: "GitLab" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    fireEvent.input(screen.getByLabelText("Host URL"), {
      target: { value: "https://git.example.com" },
    });
    fireEvent.click(screen.getByText("Continue"));

    expect((await screen.findByTestId("token-scopes")).textContent).toContain("write_repository");
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
