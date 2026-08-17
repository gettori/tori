// The accounts half of an agent card, end to end through the component.
//
// Everything on this screen came out of the agent's own probe, and the tests
// keep it that way: nothing asserts on a credential, because on macOS there is
// no credential to assert on. Phase 0 measured that `claude` keeps its tokens in
// the login Keychain, so a profile home holds nothing secret.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent, screen } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import AgentsSection from "./AgentsSection";
import { OPEN_TERMINAL, type OpenTerminal } from "../../../../utils/events";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/home/me" }));
const invoked = vi.mocked(invoke);

const health = (over: Record<string, unknown> = {}) => ({
  id: "claude",
  label: "Claude",
  program: "claude",
  status: "versionMatch",
  signIn: "unknown",
  account: null,
  apiKeySource: null,
  path: "/usr/bin/claude",
  version: "2.1.231",
  verifiedAgainst: "claude 2.1.231",
  sessionsDir: "/home/me/.claude/projects",
  sessionsDirExists: true,
  hooks: true,
  needsYou: true,
  overridePath: null,
  ...over,
});

const profile = (over: Record<string, unknown> = {}) => ({
  id: "default",
  label: "Default",
  isDefault: true,
  home: null,
  signIn: "signedIn",
  account: "a@b.c",
  apiKeySource: null,
  duplicateOf: null,
  login: { type: "terminal", program: "claude", args: ["auth", "login"], home: null },
  ...over,
});

const view = (over: Record<string, unknown> = {}) => ({
  adapterId: "claude",
  declared: true,
  canAdd: true,
  canSignOut: true,
  profiles: [profile()],
  ...over,
});

function mount(over: { health?: Record<string, unknown>; accounts?: Record<string, unknown> } = {}) {
  invoked.mockReset();
  invoked.mockImplementation(async (cmd: string) => {
    if (cmd === "agent_health") return [health(over.health)];
    if (cmd === "agent_accounts") return view(over.accounts);
    // The setup page's sign-in step, for the default profile: no home
    // variable, which is what resolves the login the user already had.
    if (cmd === "agent_login_route")
      return { type: "terminal", program: "claude", args: ["auth", "login"], home: null };
    return [];
  });
  return render(() => <AgentsSection />);
}

/** The card is a summary now: everything these tests are about lives one click
 *  in, on the agent's own page. */
async function open(r: ReturnType<typeof render>, label = "Claude") {
  const card = await r.findByRole("button", { name: new RegExp(label) });
  fireEvent.click(card);
  // A heading the list does not have, so this waits for the page rather than
  // for text both views happen to share.
  await waitFor(() => expect(r.container.textContent).toContain("Chat capabilities"));
  return r;
}

/** Terminal tabs the component asked for, in order. */
function openedTabs(): OpenTerminal[] {
  const seen: OpenTerminal[] = [];
  window.addEventListener(OPEN_TERMINAL, (e) =>
    seen.push((e as CustomEvent<OpenTerminal>).detail),
  );
  return seen;
}

describe("the sign-in state on an agent page", () => {
  beforeEach(() => invoked.mockReset());

  // Installed and signed-out are two independent facts, and this is the state
  // the setup steps exist for: the page swaps its accounts list for the plan,
  // with the install step already done.
  it("walks a signed-out agent through setup instead of listing accounts", async () => {
    const { container, getByRole } = await open(mount({ health: { signIn: "signedOut" } }));
    await waitFor(() => expect(container.textContent).toContain("Setup"));
    expect(container.textContent).toContain("1 of 3");
    expect(container.textContent).toContain("Installed");
    expect(container.textContent).toContain("Ready for chat");
    expect(getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(container.textContent).not.toContain("your existing login");
  });

  // The setup sign-in signs in the *default* profile: no home variable set is
  // what resolves the login the user already had.
  it("signs the default profile in from the setup step", async () => {
    const tabs = openedTabs();
    const { container, getByRole } = await open(mount({ health: { signIn: "signedOut" } }));
    await waitFor(() => expect(container.textContent).toContain("claude auth login"));
    fireEvent.click(getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(tabs.length).toBe(1));
    expect(tabs[0].id).toBe("signin:claude:default");
    expect(tabs[0].program).toBe("claude");
    expect(tabs[0].env).toBeUndefined();
    expect(tabs[0].recheckAgentsOnExit).toBe(true);
  });

  // Unknown is the default for every agent that cannot answer and every probe
  // that did not finish. It must not read as a problem, so no setup plan: the
  // page goes straight to the accounts it has.
  it("shows no setup steps when the sign-in state is unknown", async () => {
    const { container } = await open(mount());
    await waitFor(() => expect(container.textContent).toContain("Accounts"));
    expect(container.textContent).not.toContain("Setup");
    expect(container.textContent).not.toContain("Ready for chat");
  });

  // The agent's own statement about which credential it will bill against,
  // rather than Sway reading its environment and guessing which variables
  // matter to which agent. A notice, never a block.
  it("warns when an inherited key overrides subscription billing", async () => {
    const { container } = await open(mount({
      health: { signIn: "signedIn", apiKeySource: "ANTHROPIC_API_KEY" },
    }));
    await waitFor(() => expect(container.textContent).toContain("ANTHROPIC_API_KEY"));
    expect(container.textContent).toContain("rather than the subscription");
    // Still usable: the warning sits beside a working agent rather than in
    // place of one, and the verdict pill keeps saying so.
    expect(container.textContent).toContain("Ready");
  });
});

describe("the accounts list", () => {
  beforeEach(() => invoked.mockReset());

  it("lists the default profile as the user's existing login", async () => {
    const { container } = await open(mount());
    await waitFor(() => expect(container.textContent).toContain("Accounts"));
    expect(container.textContent).toContain("your existing login");
  });

  it("shows the account the agent named for a profile", async () => {
    const { container } = await open(mount());
    await waitFor(() => expect(container.textContent).toContain("a@b.c"));
  });

  // There is nothing stored to remove, and "removing" it could only mean
  // signing the user out of the login they had before Sway existed.
  it("offers no remove button for the default profile", async () => {
    const { container, queryByText } = await open(mount());
    await waitFor(() => expect(container.textContent).toContain("Accounts"));
    expect(queryByText("Sign out and remove")).toBeNull();
  });

  it("offers remove for a profile Sway added", async () => {
    const { container, getByText } = await open(mount({
      accounts: {
        profiles: [profile(), profile({ id: "work", label: "Work", isDefault: false, home: "/h/w" })],
      },
    }));
    await waitFor(() => expect(container.textContent).toContain("Work"));
    expect(getByText("Sign out and remove")).toBeTruthy();
  });

  // An adapter that offers no logout has to say so at the point it matters,
  // because removing the account there does not revoke anything.
  it("labels removal plainly when the agent has no sign-out command", async () => {
    const { container, getByText } = await open(mount({
      accounts: {
        canSignOut: false,
        profiles: [profile({ id: "work", label: "Work", isDefault: false, home: "/h/w" })],
      },
    }));
    await waitFor(() => expect(container.textContent).toContain("Work"));
    expect(getByText("Remove")).toBeTruthy();
  });

  // Two profiles on one account is a thing somebody may genuinely want, so this
  // says what it sees rather than refusing.
  it("warns about a second profile signed in to the same account", async () => {
    const { container } = await open(mount({
      accounts: {
        profiles: [
          profile(),
          profile({ id: "work", label: "Work", isDefault: false, duplicateOf: "Default" }),
        ],
      },
    }));
    await waitFor(() => expect(container.textContent).toContain("Work"));
    expect(container.textContent).toContain("same account as Default");
  });

  // Isolation is measured, never inferred from having a home variable. The
  // button stays on screen, disabled beside the reason, so "why can I not add
  // a second account here" has an answer where the answer matters.
  it("says why adding is off for a agent with no measured isolation", async () => {
    const { container, getByText } = await open(mount({ accounts: { canAdd: false } }));
    await waitFor(() => expect(container.textContent).toContain("Accounts"));
    const button = getByText("Add account").closest("button")!;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain("two accounts at once");
  });

  // "Sway has nothing true to say about this agent's accounts" is not the
  // same claim as "nobody is signed in", so it renders no controls at all.
  it("renders nothing for an adapter that declares no accounts table", async () => {
    const { container } = await open(mount({ accounts: { declared: false, profiles: [] } }));
    expect(container.textContent).not.toContain("Accounts");
  });

  // An account list under a binary that is not there would be a set of controls
  // with nothing behind them.
  it("renders nothing for a agent that is not installed", async () => {
    const { container } = await open(mount({ health: { status: "notFound", path: null, version: null } }));
    await waitFor(() => expect(container.textContent).toContain("Not installed"));
    expect(container.textContent).not.toContain("Accounts");
  });
});

describe("signing in", () => {
  beforeEach(() => invoked.mockReset());

  // A login is browser OAuth with no non-interactive variant, so the only
  // honest thing the button can do is hand the user a real terminal.
  it("opens a terminal tab rather than trying to complete the login", async () => {
    const tabs = openedTabs();
    const { container, getByText } = await open(mount({
      accounts: { profiles: [profile({ signIn: "signedOut" })] },
    }));
    await waitFor(() => expect(container.textContent).toContain("Accounts"));
    fireEvent.click(getByText("Sign in"));
    await waitFor(() => expect(tabs.length).toBe(1));
    expect(tabs[0].program).toBe("claude");
    expect(tabs[0].args).toEqual(["auth", "login"]);
    // Completing it has to flip the state without a restart.
    expect(tabs[0].recheckAgentsOnExit).toBe(true);
  });

  // The route is per profile, not per card. When it was one field on the whole
  // view, every press opened a tab with no home variable, so signing in to
  // "Work" signed the user into the login they already had and said it worked.
  it("signs each profile in to its own home", async () => {
    const tabs = openedTabs();
    const { container, getAllByText } = await open(mount({
      accounts: {
        profiles: [
          profile({ signIn: "signedOut" }),
          profile({
            id: "work",
            label: "Work",
            isDefault: false,
            signIn: "signedOut",
            home: "/canonical/work",
            login: {
              type: "terminal",
              program: "claude",
              args: ["auth", "login"],
              home: ["CLAUDE_CONFIG_DIR", "/canonical/work"],
            },
          }),
        ],
      },
    }));
    await waitFor(() => expect(container.textContent).toContain("Work"));

    const buttons = getAllByText("Sign in");
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(tabs.length).toBe(2));

    // The default profile is the variable left unset, which is what makes it
    // resolve the login the user already had.
    expect(tabs[0].env).toBeUndefined();
    expect(tabs[1].env).toEqual({ CLAUDE_CONFIG_DIR: "/canonical/work" });
    // Two logins, so two tabs rather than one that gets reused.
    expect(tabs[0].id).not.toBe(tabs[1].id);
  });

  // An account is a transcript root. Nothing watches a root that did not exist
  // when the watcher started, so the new account's sessions would appear only
  // when something else happened to ask for a listing.
  it("watches the new account's transcripts as soon as it exists", async () => {
    const { container, getByText } = await open(mount());
    await waitFor(() => expect(container.textContent).toContain("Accounts"));

    fireEvent.click(getByText("Add account"));
    // The modal portals out of the component's own container.
    const input = await waitFor(() => screen.getByRole("textbox"));
    fireEvent.input(input, { target: { value: "Work" } });
    fireEvent.click(screen.getByText("Create and sign in"));

    await waitFor(() =>
      expect(invoked.mock.calls.some((c) => c[0] === "add_agent_account")).toBe(true),
    );
    await waitFor(() =>
      expect(invoked.mock.calls.some((c) => c[0] === "sessions_watch_start")).toBe(true),
    );
  });

  it("offers no sign-in button for a profile already signed in", async () => {
    const { container, queryByText } = await open(mount());
    await waitFor(() => expect(container.textContent).toContain("Accounts"));
    expect(queryByText("Sign in")).toBeNull();
  });
});

describe("signing out", () => {
  beforeEach(() => invoked.mockReset());

  // Recoverable, so a plain button and no dialog: the agent's own logout
  // revokes the credential and the profile stays, ready to sign back in.
  it("signs a profile out through the agent's own logout command", async () => {
    const { container, getByRole } = await open(mount());
    await waitFor(() => expect(container.textContent).toContain("Accounts"));

    fireEvent.click(getByRole("button", { name: "Sign out" }));

    await waitFor(() =>
      expect(
        invoked.mock.calls.some(
          ([cmd, args]) =>
            cmd === "sign_out_agent_account" &&
            (args as { profileId?: string })?.profileId === "default",
        ),
      ).toBe(true),
    );
  });

  // `canSignOut` is the backend saying a logout command exists; without one
  // the button could only pretend, so it is not there at all.
  it("offers no sign-out where the adapter declares no logout command", async () => {
    const { container, queryByRole } = await open(mount({ accounts: { canSignOut: false } }));
    await waitFor(() => expect(container.textContent).toContain("Accounts"));
    expect(queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});
