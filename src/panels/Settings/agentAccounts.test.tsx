// The accounts half of an agent card, end to end through the component.
//
// Everything on this screen came out of the harness's own probe, and the tests
// keep it that way: nothing asserts on a credential, because on macOS there is
// no credential to assert on. Phase 0 measured that `claude` keeps its tokens in
// the login Keychain, so a profile home holds nothing secret.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import AgentsSection from "./AgentsSection";
import { OPEN_TERMINAL, type OpenTerminal } from "../../utils/events";

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
    if (cmd === "acp_catalog") return [];
    if (cmd === "acp_catalog_source") return null;
    return [];
  });
  return render(() => <AgentsSection />);
}

/** Terminal tabs the component asked for, in order. */
function openedTabs(): OpenTerminal[] {
  const seen: OpenTerminal[] = [];
  window.addEventListener(OPEN_TERMINAL, (e) =>
    seen.push((e as CustomEvent<OpenTerminal>).detail),
  );
  return seen;
}

describe("the sign-in state on an agent card", () => {
  beforeEach(() => invoked.mockReset());

  // The third state Phase 1 could not render, because nothing produced it yet.
  // Installed and signed-out are two independent facts.
  it("says an installed harness is signed out, and why that matters", async () => {
    const { container } = mount({ health: { signIn: "signedOut" } });
    await waitFor(() => expect(container.textContent).toContain("Installed, version 2.1.231"));
    expect(container.textContent).toContain("Nobody is signed in");
    expect(container.textContent).toContain("not offered for a new session");
  });

  // Unknown is the default for every harness that cannot answer and every probe
  // that did not finish. It must not read as a problem.
  it("says nothing at all when the sign-in state is unknown", async () => {
    const { container } = mount();
    await waitFor(() => expect(container.textContent).toContain("Installed, version 2.1.231"));
    expect(container.textContent).not.toContain("Nobody is signed in");
  });

  it("names the account when the harness names one", async () => {
    const { container } = mount({ health: { signIn: "signedIn", account: "a@b.c" } });
    await waitFor(() => expect(container.textContent).toContain("Signed in as a@b.c"));
  });

  // The harness's own statement about which credential it will bill against,
  // rather than Sway reading its environment and guessing which variables
  // matter to which agent. A notice, never a block.
  it("warns when an inherited key overrides subscription billing", async () => {
    const { container } = mount({
      health: { signIn: "signedIn", apiKeySource: "ANTHROPIC_API_KEY" },
    });
    await waitFor(() => expect(container.textContent).toContain("ANTHROPIC_API_KEY"));
    expect(container.textContent).toContain("rather than the subscription");
    // Still installed and still usable: the warning sits beside a working
    // harness rather than in place of one.
    expect(container.textContent).toContain("Installed, version 2.1.231");
  });
});

describe("the accounts list", () => {
  beforeEach(() => invoked.mockReset());

  it("lists the default profile as the user's existing login", async () => {
    const { container } = mount();
    await waitFor(() => expect(container.textContent).toContain("Accounts"));
    expect(container.textContent).toContain("your existing login");
  });

  // There is nothing stored to remove, and "removing" it could only mean
  // signing the user out of the login they had before Sway existed.
  it("offers no remove button for the default profile", async () => {
    const { container, queryByText } = mount();
    await waitFor(() => expect(container.textContent).toContain("Accounts"));
    expect(queryByText("Sign out and remove")).toBeNull();
  });

  it("offers remove for a profile Sway added", async () => {
    const { container, getByText } = mount({
      accounts: {
        profiles: [profile(), profile({ id: "work", label: "Work", isDefault: false, home: "/h/w" })],
      },
    });
    await waitFor(() => expect(container.textContent).toContain("Work"));
    expect(getByText("Sign out and remove")).toBeTruthy();
  });

  // An adapter that offers no logout has to say so at the point it matters,
  // because removing the account there does not revoke anything.
  it("labels removal plainly when the harness has no sign-out command", async () => {
    const { container, getByText } = mount({
      accounts: {
        canSignOut: false,
        profiles: [profile({ id: "work", label: "Work", isDefault: false, home: "/h/w" })],
      },
    });
    await waitFor(() => expect(container.textContent).toContain("Work"));
    expect(getByText("Remove")).toBeTruthy();
  });

  // Two profiles on one account is a thing somebody may genuinely want, so this
  // says what it sees rather than refusing.
  it("warns about a second profile signed in to the same account", async () => {
    const { container } = mount({
      accounts: {
        profiles: [
          profile(),
          profile({ id: "work", label: "Work", isDefault: false, duplicateOf: "Default" }),
        ],
      },
    });
    await waitFor(() => expect(container.textContent).toContain("Work"));
    expect(container.textContent).toContain("same account as Default");
  });

  // Isolation is measured, never inferred from having a home variable, and the
  // absence of the button is explained rather than left as a gap.
  it("says why there is no add button for a harness with no measured isolation", async () => {
    const { container, queryByText } = mount({ accounts: { canAdd: false } });
    await waitFor(() => expect(container.textContent).toContain("Accounts"));
    expect(queryByText("Add account")).toBeNull();
    expect(container.textContent).toContain("two accounts at once");
  });

  // "Sway has nothing true to say about this harness's accounts" is not the
  // same claim as "nobody is signed in", so it renders no controls at all.
  it("renders nothing for an adapter that declares no accounts table", async () => {
    const { container } = mount({ accounts: { declared: false, profiles: [] } });
    await waitFor(() => expect(container.textContent).toContain("Installed, version"));
    expect(container.textContent).not.toContain("Accounts");
  });

  // An account list under a binary that is not there would be a set of controls
  // with nothing behind them.
  it("renders nothing for a harness that is not installed", async () => {
    const { container } = mount({ health: { status: "notFound", path: null, version: null } });
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
    const { container, getByText } = mount({
      accounts: { profiles: [profile({ signIn: "signedOut" })] },
    });
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
    const { container, getAllByText } = mount({
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
    });
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

  it("offers no sign-in button for a profile already signed in", async () => {
    const { container, queryByText } = mount();
    await waitFor(() => expect(container.textContent).toContain("Accounts"));
    expect(queryByText("Sign in")).toBeNull();
  });
});
