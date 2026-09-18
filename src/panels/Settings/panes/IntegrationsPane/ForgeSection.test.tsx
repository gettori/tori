import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@solidjs/testing-library";
import { pointerClick } from "../../../../test/menus";
import userEvent from "@testing-library/user-event";
import type {
  AuthState,
  ForgeAccount,
  ForgeErrorDto,
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
let deviceLifetimeSecs = 900;
let clipboardWorks = true;
let tokenRejection: ForgeErrorDto | null = null;
/** What Rust files after a paste. The card can only be right if it reads the
 *  account back, since the scopes and the date come from the host, not the
 *  paste. `null` keeps the older tests on the bare accountId Rust answers with. */
let pasted: ForgeAccount | null = null;
let handoff: string[] = [];
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
  return { id, provider: "github", baseUrl: "https://github.com", login, label: login ?? "", expiresAt: null, rejectedAt: null, scopes: null, source: "token", orgAccess: [], auth, ...extra };
}

function hostOf(host: string, accounts: ForgeAccount[], extra: Partial<ForgeHost> = {}): ForgeHost {
  return { host, accounts, gitCredentials: false, gitEverywhere: false, defaultAccount: null, appId: null, ...extra };
}

const on = (login: string) => account(`github-com-${login}`, { kind: "signedIn", login }, login);
const rejected = (login: string, rejectedAt: number | null) =>
  account(`github-com-${login}`, { kind: "suspect", login }, login, { rejectedAt });

/** Rust's ladder, reduced to the facts these tests branch on: a browser route
 *  exists on GitLab only, on gitlab.com through Tori's own application and on
 *  any other instance through whichever one was registered there. GitHub has
 *  none at all, because an organisation can refuse to approve it. */
function routesFor(baseUrl: string, provider: ForgeProvider = "github"): SignInRoutes {
  const host = new URL(baseUrl).host;
  const cloud = host === "github.com" || host === "gitlab.com";
  const appId = cloud ? null : (appIds[host] ?? null);
  // Rust's other rule: GitHub's `repo` already carries push, while GitLab needs
  // the git scope named separately once the host answers git.
  const scopes =
    provider === "gitlab" ? (gitCredentials[host] ? ["api", "write_repository"] : ["api"]) : ["repo", "workflow"];
  return {
    host,
    baseUrl,
    deviceFlow: provider === "gitlab" && (host === "gitlab.com" || appId !== null),
    scopes,
    tokenUrl: `${baseUrl}/settings/tokens/new?scopes=${scopes.join(",")}`,
    appId,
  };
}

/** Whom `gh` is logged in as on this machine, or nobody. */
let ghLogin: string | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "plugin:opener|open_url":
        handoff.push(`open ${args?.url as string}`);
        return Promise.resolve();
      case "forge_accounts":
        return Promise.resolve(hosts);
      case "forge_sign_in_start": {
        calls.start += 1;
        const provider = args?.provider as ForgeProvider;
        const routes = routesFor(args?.baseUrl as string, provider);
        if (provider === "github" && ghLogin) {
          return Promise.resolve({ kind: "signedIn", accountId: `github-com-${ghLogin}`, login: ghLogin });
        }
        if (!routes.deviceFlow) return Promise.resolve({ kind: "token", routes });
        return Promise.resolve({
          kind: "browser",
          routes,
          prompt: {
            userCode: "WDJB-MJHT",
            verificationUri: "https://github.com/login/device",
            expiresInSecs: deviceLifetimeSecs,
            intervalSecs: 5,
          },
        });
      }
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
      case "forge_add_token": {
        if (tokenRejection) return Promise.reject(tokenRejection);
        if (!pasted) return Promise.resolve({ accountId: "a", login: "a" });
        const host = new URL(args?.baseUrl as string).host;
        hosts = hosts.some((h) => h.host === host)
          ? hosts.map((h) => (h.host === host ? { ...h, accounts: [...h.accounts, pasted!] } : h))
          : [...hosts, hostOf(host, [pasted])];
        return Promise.resolve({ accountId: pasted.id, login: pasted.login });
      }
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

vi.mock("../../../../utils/clipboard", () => ({
  copyText: () => {
    handoff.push("copy");
    return Promise.resolve(clipboardWorks);
  },
}));
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
  deviceLifetimeSecs = 900;
  clipboardWorks = true;
  tokenRejection = null;
  pasted = null;
  handoff = [];
  ghLogin = null;
});

/** The picker, then gitlab.com, which is the one cloud with a browser route. */
async function startBrowserSignIn() {
  fireEvent.click(await screen.findByText("Another host..."));
  pointerClick(await screen.findByRole("radio", { name: /gitlab\.com/ }));
  fireEvent.click(flowCard().getByText("Continue"));
  await screen.findByTestId("device-code");
}

const flowCard = () => within(screen.getByTestId("add-flow"));

/** Picker, Enterprise tile, host URL, then the token step for that host. */
async function reachEnterpriseToken(url = "https://ghe.example.com") {
  fireEvent.click(await screen.findByText("Another host..."));
  pointerClick(await screen.findByRole("radio", { name: /GitHub Enterprise/ }));
  fireEvent.click(flowCard().getByText("Continue"));
  fireEvent.input(await screen.findByLabelText("Host URL"), { target: { value: url } });
  fireEvent.click(flowCard().getByText("Continue"));
  await screen.findByLabelText("Personal access token");
}

const refused = (message: string): ForgeErrorDto => ({
  kind: "invalid",
  message,
  rateLimitKind: null,
  retryAfterSecs: null,
  resetAtSecs: null,
  org: null,
});

describe("the forge accounts settings section", () => {
  it("offers connecting github.com, with the global switch inert, when there is no host", async () => {
    render(() => <ForgeSection />);
    expect(await screen.findByText("No hosts connected")).toBeTruthy();
    expect(screen.getByText("Connect github.com")).toBeTruthy();
    expect(screen.getByText("Another host...")).toBeTruthy();
    expect(screen.getByText("Available once a host is connected.")).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText("Show pull requests and checks") as HTMLInputElement).disabled).toBe(true));
  });

  it("gives one github.com account a card with its tag, status and one account's switch", async () => {
    hosts = [hostOf("github.com", [on("octocat")])];
    render(() => <ForgeSection />);
    const card = await screen.findByTestId("forge-host");
    expect(card.textContent).toContain("GitHub");
    expect(card.textContent).toContain("signed in");
    expect(card.textContent).toContain("Use this account for git push and fetch");
    expect(card.textContent).toContain(
      "Covers Tori's own git, terminal tabs and agents. Tabs and agents already open need reopening after you turn it on.",
    );
    expect(card.textContent).toContain(
      "Tori has to be running: while it's closed, git on github.com asks you.",
    );
    expect(screen.getByLabelText("Connect a host")).toBeTruthy();
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

  it("leaves the date out of the rejection when Tori never recorded one", async () => {
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

  it("hands git this host's account once the switch is on", async () => {
    hosts = [
      {
        host: "github.com",
        accounts: [account("github-com-skarif2", { kind: "signedIn", login: "skarif2" }, "skarif2")],
        gitCredentials: false,
        gitEverywhere: false,
        defaultAccount: null,
        appId: null,
      },
    ];
    render(() => <ForgeSection />);
    fireEvent.click(await screen.findByLabelText("Use github.com for git push and fetch"));
    await waitFor(() => expect(calls.gitCredentials).toEqual([["github.com", true]]));
  });

  it("says what each host does rather than which route it will take", async () => {
    // The route is Rust's decision, made once the host is asked, so a badge
    // here would be a guess the user then has to reconcile with what happened.
    render(() => <ForgeSection />);
    fireEvent.click(await screen.findByText("Another host..."));
    await waitFor(() => expect(flowCard().getByText("github.com")).toBeTruthy());
    expect(flowCard().getByText("Uses your GitHub CLI login when you have one.")).toBeTruthy();
    expect(flowCard().getByText("No fields. Opens your browser.")).toBeTruthy();
    expect(flowCard().queryByText("browser")).toBeNull();
  });

  it("signs github.com in from the gh login without ever showing a card", async () => {
    ghLogin = "skarif2";
    render(() => <ForgeSection />);
    fireEvent.click(await screen.findByText("Connect github.com"));

    await waitFor(() => expect(calls.start).toBe(1));
    expect(screen.queryByTestId("add-flow"), "no token field, no device code").toBeNull();
    expect(screen.queryByLabelText("Personal access token")).toBeNull();
  });

  it("falls back to a token on github.com when there is no gh login to read", async () => {
    render(() => <ForgeSection />);
    fireEvent.click(await screen.findByText("Connect github.com"));

    expect(await screen.findByLabelText("Personal access token")).toBeTruthy();
    expect(screen.queryByTestId("device-code"), "GitHub has no browser route").toBeNull();
  });

  it("walks to self-managed GitLab with the arrow keys and commits with Enter", async () => {
    const user = userEvent.setup();
    render(() => <ForgeSection />);
    fireEvent.click(await screen.findByText("Another host..."));
    const first = await screen.findByRole("radio", { name: /github\.com/ });
    await waitFor(() => expect(document.activeElement).toBe(first));

    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    expect(await screen.findByLabelText("Host URL")).toBeTruthy();
    expect(flowCard().getByText("GitLab, self-managed")).toBeTruthy();
  });

  it("offers an Application ID only on a self-managed card, and its saved id opens the browser there", async () => {
    const gitlab = (host: string) =>
      account(`${host}-arif`, { kind: "signedIn", login: "arif" }, "arif", {
        provider: "gitlab",
        baseUrl: `https://${host}`,
      });
    hosts = [hostOf("gitlab.com", [gitlab("gitlab.com")]), hostOf("git.example.com", [gitlab("git.example.com")])];
    render(() => <ForgeSection />);
    const [cloud, own] = await screen.findAllByTestId("forge-host");
    expect(within(cloud).queryByText("Application ID")).toBeNull();

    fireEvent.click(within(own).getByText("Application ID"));
    fireEvent.input(await screen.findByLabelText("Application ID for git.example.com"), { target: { value: "app-123" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(appIds["git.example.com"]).toBe("app-123"));

    fireEvent.click(screen.getByLabelText("Add account on git.example.com"));
    await waitFor(() => expect(calls.start).toBe(1));
  });

  it("asks a self-hosted product for its URL, and says why the browser is not there yet", async () => {
    render(() => <ForgeSection />);
    fireEvent.click(await screen.findByText("Another host..."));
    pointerClick(await screen.findByRole("radio", { name: /GitLab, self-managed/ }));
    fireEvent.click(flowCard().getByText("Continue"));

    expect(await screen.findByLabelText("Host URL")).toBeTruthy();
    expect(screen.getByTestId("host-url-hint").textContent).toBe("https only. Next step is a token.");
    expect(flowCard().getByText(/needs its OAuth Application ID/)).toBeTruthy();
    fireEvent.click(flowCard().getByText("Add later"));
    expect(flowCard().queryByText(/needs its OAuth Application ID/)).toBeNull();
  });

  it("names GitHub's two scopes on its token step, and what the second is for", async () => {
    render(() => <ForgeSection />);
    await reachEnterpriseToken();
    const scopes = screen.getByTestId("token-scopes");
    expect(within(scopes).getAllByText(/^repo$/)).toHaveLength(1);
    expect(within(scopes).getAllByText(/^workflow$/)).toHaveLength(1);
    expect(scopes.textContent).toContain("The second only if you push changes to GitHub Actions.");
    expect(flowCard().getByText("Create a token on ghe.example.com")).toBeTruthy();
    expect(flowCard().getByText("Enterprise")).toBeTruthy();
  });

  it("asks a classic GitHub token without workflow to sign in again, and leaves the rest alone", async () => {
    // An empty list is a fine-grained token and null was never asked: neither is
    // known to lack the permission, so neither is told it does.
    hosts = [
      hostOf("github.com", [
        account("github-com-old", { kind: "signedIn", login: "old" }, "old", { scopes: ["repo"] }),
        account("github-com-new", { kind: "signedIn", login: "new" }, "new", { scopes: ["repo", "workflow"] }),
        account("github-com-fine", { kind: "signedIn", login: "fine" }, "fine", { scopes: [] }),
        account("github-com-unasked", { kind: "signedIn", login: "unasked" }, "unasked"),
      ]),
    ];
    render(() => <ForgeSection />);
    const rows = await screen.findAllByTestId("forge-account");
    const nudged = rows.filter((row) => within(row).queryByTestId("workflow-notice"));
    expect(nudged).toHaveLength(1);
    expect(within(nudged[0]).getByText("old")).toBeTruthy();
    expect(within(nudged[0]).getByText("Pushes that change GitHub Actions need a newer sign-in.")).toBeTruthy();
    expect(within(nudged[0]).getByText("Sign in again")).toBeTruthy();
    expect(screen.getAllByText("Sign in again")).toHaveLength(1);
  });

  it("says what the host granted a pasted token and what it withheld", async () => {
    // Noon UTC, so the date reads the same in every timezone the suite runs in.
    pasted = account("ghe-example-com-arif", { kind: "signedIn", login: "arif" }, "arif", {
      baseUrl: "https://ghe.example.com",
      scopes: ["repo"],
      expiresAt: Date.UTC(2027, 0, 3, 12) / 1000,
    });
    render(() => <ForgeSection />);
    await reachEnterpriseToken();
    fireEvent.input(screen.getByLabelText("Personal access token"), { target: { value: "ghp_narrow" } });
    fireEvent.click(flowCard().getByText("Sign in"));

    const scopes = await screen.findByTestId("granted-scopes");
    expect(within(scopes).getByText("repo")).toBeTruthy();
    expect(within(scopes).queryByText("workflow")).toBeNull();
    expect(screen.getByTestId("missing-scopes").textContent).toContain(
      "ghe.example.com did not grant workflow",
    );
    expect(screen.getByTestId("granted-expiry").textContent).toContain("Expires on 3 Jan 2027");
  });

  it("tells a token with no expiration that it will not be asked for again", async () => {
    pasted = account("ghe-example-com-arif", { kind: "signedIn", login: "arif" }, "arif", {
      baseUrl: "https://ghe.example.com",
      scopes: ["repo", "workflow"],
    });
    render(() => <ForgeSection />);
    await reachEnterpriseToken();
    fireEvent.input(screen.getByLabelText("Personal access token"), { target: { value: "ghp_wide" } });
    fireEvent.click(flowCard().getByText("Sign in"));

    expect((await screen.findByTestId("granted-expiry")).textContent).toBe(
      "No expiration, so Tori will not ask for this token again.",
    );
    expect(screen.queryByTestId("missing-scopes")).toBeNull();
    fireEvent.click(flowCard().getByText("Done"));
    await waitFor(() => expect(screen.queryByTestId("add-flow")).toBeNull());
  });

  it("carries a blocked organisation to the page that can unblock it", async () => {
    // Authorizing is GitHub's own decision on GitHub's own page, so the row's
    // whole job is to name the org and hand the user the URL it was refused with.
    hosts = [
      hostOf("github.com", [
        account("github-com-arif", { kind: "signedIn", login: "arif" }, "arif", {
          orgAccess: [
            { org: "acme", url: "https://github.com/orgs/acme/sso?authorization_request=AR_one" },
            { org: "globex", url: "https://github.com/orgs/globex/sso?authorization_request=AR_two" },
          ],
        }),
        account("github-com-clear", { kind: "signedIn", login: "clear" }, "clear"),
      ]),
    ];
    render(() => <ForgeSection />);
    const rows = await screen.findAllByTestId("forge-account");
    expect(rows.filter((row) => within(row).queryByTestId("org-access-notice"))).toHaveLength(1);

    const notice = screen.getByTestId("org-access-notice");
    expect(notice.textContent).toContain("Organisations have not let this account through:");
    fireEvent.click(within(notice).getByText("Authorize for globex"));
    await waitFor(() =>
      expect(handoff).toEqual(["open https://github.com/orgs/globex/sso?authorization_request=AR_two"]),
    );
  });

  it("counts a token down to its date, then turns the row back into the one button", async () => {
    // Only Date is faked: the async waits below still need real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 19, 12));
    hosts = [
      hostOf("github.com", [
        account("github-com-soon", { kind: "signedIn", login: "soon" }, "soon", {
          expiresAt: Date.UTC(2026, 8, 23, 12) / 1000,
        }),
        account("github-com-lapsed", { kind: "signedIn", login: "lapsed" }, "lapsed", {
          expiresAt: Date.UTC(2026, 8, 17, 12) / 1000,
        }),
        account("github-com-far", { kind: "signedIn", login: "far" }, "far", {
          expiresAt: Date.UTC(2027, 0, 3, 12) / 1000,
        }),
      ]),
    ];
    render(() => <ForgeSection />);
    const rows = await screen.findAllByTestId("forge-account");
    expect(rows.map((row) => within(row).queryByTestId("expiry-notice")?.textContent ?? null)).toEqual([
      "This token expires on 23 Sep 2026. Signing in again replaces it in place.",
      "This token expired on 17 Sep 2026. Signing in again replaces it in place.",
      // Months out is not news yet, so the row says nothing and offers nothing.
      null,
    ]);
    expect(screen.getAllByText("Sign in again")).toHaveLength(2);
    vi.useRealTimers();
  });

  it("names the git scope on a GitLab host whose push switch is on", async () => {
    // `api` alone cannot push, so a token pasted for a host with the switch on
    // would sign in and then fail on the first push.
    hosts = [
      hostOf(
        "git.example.com",
        [
          account("git-example-com-arif", { kind: "signedIn", login: "arif" }, "arif", {
            provider: "gitlab",
            baseUrl: "https://git.example.com",
          }),
        ],
        { gitCredentials: true },
      ),
    ];
    gitCredentials["git.example.com"] = true;
    render(() => <ForgeSection />);
    fireEvent.click(await screen.findByLabelText("Add account on git.example.com"));

    const scopes = await screen.findByTestId("token-scopes");
    expect(within(scopes).getByText("api")).toBeTruthy();
    expect(within(scopes).getByText("write_repository")).toBeTruthy();
    expect(scopes.textContent).toContain("The second only if you push over git.example.com.");
  });

  it("puts the code on the clipboard before it opens the page, and says so", async () => {
    render(() => <ForgeSection />);
    await startBrowserSignIn();

    expect(screen.getByTestId("device-code").textContent).toBe("WDJBMJHT");
    expect(await screen.findByTestId("clipboard-confirmation")).toBeTruthy();
    await waitFor(() => expect(handoff).toEqual(["copy", "open https://github.com/login/device"]));
  });

  it("offers copying the code by hand when the clipboard refused it", async () => {
    clipboardWorks = false;
    render(() => <ForgeSection />);
    await startBrowserSignIn();
    const copy = await screen.findByText("Copy the code");
    expect(screen.queryByTestId("clipboard-confirmation")).toBeNull();

    clipboardWorks = true;
    fireEvent.click(copy);
    expect(await screen.findByTestId("clipboard-confirmation")).toBeTruthy();
  });

  it("counts down to the host's own expiry", async () => {
    vi.useFakeTimers();
    render(() => <ForgeSection />);
    await startBrowserSignIn();
    expect((await screen.findByTestId("expires")).textContent).toBe("expires in 15:00");

    await vi.advanceTimersByTimeAsync(61_000);
    expect(screen.getByTestId("expires").textContent).toBe("expires in 13:59");
    vi.useRealTimers();
  });

  it("stops polling and cancels the flow in Rust when the user cancels", async () => {
    vi.useFakeTimers();
    render(() => <ForgeSection />);
    await startBrowserSignIn();
    fireEvent.click(flowCard().getByText("Cancel"));

    expect(calls.cancel).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.poll).toBe(0);
    vi.useRealTimers();
  });

  it("cancels on Escape without letting it reach the panel", async () => {
    // `Settings.tsx` closes the whole panel on an Escape that reaches it.
    let panelEscapes = 0;
    render(() => (
      <div onKeyDown={(e) => e.key === "Escape" && panelEscapes++}>
        <ForgeSection />
      </div>
    ));
    await startBrowserSignIn();
    fireEvent.keyDown(screen.getByTestId("add-flow"), { key: "Escape" });

    expect(panelEscapes).toBe(0);
    expect(screen.queryByTestId("add-flow")).toBeNull();
    expect(screen.getByText("No hosts connected")).toBeTruthy();
    await waitFor(() => expect(calls.cancel).toBe(1));
  });

  it("asks the host at expiry and shows its expired_token on the error card", async () => {
    deviceLifetimeSecs = 120;
    const pending = { kind: "pending", nextIntervalSecs: 5 };
    devicePolls = [...Array(23).fill(pending), { kind: "expired", code: "expired_token" }];
    vi.useFakeTimers();
    render(() => <ForgeSection />);
    await startBrowserSignIn();
    await vi.advanceTimersByTimeAsync(119_000);
    expect(screen.queryByTestId("flow-error")).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);

    const sentence = screen.getByTestId("flow-error").textContent;
    expect(sentence).toContain("gitlab.com expired the code before it was entered: expired_token.");
    expect(sentence).toContain("Codes last about 2 minutes.");
    expect(flowCard().getByText("Paste a token instead")).toBeTruthy();
    vi.useRealTimers();
  });

  it("quotes a denied sign-in, offers a token instead, and stops polling", async () => {
    devicePolls = [{ kind: "denied", code: "access_denied" }];
    vi.useFakeTimers();
    render(() => <ForgeSection />);
    await startBrowserSignIn();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(screen.getByTestId("flow-error").textContent).toContain(
      "gitlab.com says the sign-in was denied: access_denied.",
    );
    expect(flowCard().getByText("gitlab.com via browser")).toBeTruthy();
    const pollsAfterDenial = calls.poll;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.poll, "a denied flow must stop polling").toBe(pollsAfterDenial);
    vi.useRealTimers();
  });

  it("never offers the browser back after a refused token, even where the host has one", async () => {
    // A token is the fallback Rust already chose; offering the browser from
    // here would put the user back on the route that just failed.
    devicePolls = [{ kind: "denied", code: "access_denied" }];
    tokenRejection = refused("gitlab.com rejected that token.");
    vi.useFakeTimers();
    render(() => <ForgeSection />);
    await startBrowserSignIn();
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();

    fireEvent.click(flowCard().getByText("Paste a token instead"));
    fireEvent.input(await screen.findByLabelText("Personal access token"), { target: { value: "glpat_x" } });
    await waitFor(() => expect(screen.getByTestId("token-scopes")).toBeTruthy());
    fireEvent.click(flowCard().getByText("Sign in"));

    expect((await screen.findByTestId("flow-error")).textContent).toBe("gitlab.com rejected that token. invalid");
    expect(flowCard().queryByText("Sign in with browser instead")).toBeNull();
    expect(flowCard().queryByText("Paste a token instead")).toBeNull();
  });

  it("offers no second route after a refused token on a host with no browser sign-in", async () => {
    tokenRejection = refused("ghe.example.com rejected that token.");
    render(() => <ForgeSection />);
    await reachEnterpriseToken();
    fireEvent.input(screen.getByLabelText("Personal access token"), { target: { value: "ghp_x" } });
    fireEvent.click(flowCard().getByText("Sign in"));

    expect((await screen.findByTestId("flow-error")).textContent).toBe("ghe.example.com rejected that token. invalid");
    expect(flowCard().getByText("ghe.example.com via token")).toBeTruthy();
    expect(flowCard().queryByText("Sign in with browser instead")).toBeNull();
    expect(flowCard().queryByText("Paste a token instead")).toBeNull();

    fireEvent.click(flowCard().getByText("Start again"));
    expect(await screen.findByLabelText("Personal access token")).toBeTruthy();
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

    unmount();
    await waitFor(() => expect(calls.cancel).toBe(1));
  });
});
