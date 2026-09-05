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
import { __resetModelCatalogsForTests, type ModelCatalog } from "../../../../utils/modelCatalog";
import { OPEN_JOB, type OpenJob } from "../../../../utils/events";
import styles from "../../Settings.module.css";

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

/** One account's answer to "what can you run", which is where the plan and the
 *  model count on its row come from. */
const catalogue = (profileId: string, plan: string, models: string[]): ModelCatalog => ({
  agentId: "claude",
  profileId,
  state: "probed",
  catalogue: {
    version: "2.1.231",
    probedAtMs: Date.parse("2026-09-01T12:00:00Z"),
    models: models.map((value) => ({
      value,
      resolvedModel: value,
      displayName: value,
      description: "",
      supportsEffort: false,
      supportedEffortLevels: [],
      supportsAutoMode: false,
      supportsFastMode: false,
      supportsAdaptiveThinking: false,
    })),
    modes: [],
    account: { subscriptionType: plan, organization: "", apiProvider: "firstParty" },
  },
  lastFailure: null,
});

function mount(
  over: {
    health?: Record<string, unknown>;
    accounts?: Record<string, unknown>;
    catalogs?: ModelCatalog[];
  } = {},
) {
  invoked.mockReset();
  // The catalogue store reads once per app run and keeps the answer, so a
  // second mount in this file would otherwise be handed the first test's.
  __resetModelCatalogsForTests();
  invoked.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "agent_health") return [health(over.health)];
    if (cmd === "agent_accounts") return view(over.accounts);
    if (cmd === "model_catalogs") return over.catalogs ?? [];
    // Handed back rather than swallowed: the store applies what this returns,
    // and an empty list here would leave the panel reading a settings object
    // that is an array.
    if (cmd === "set_settings") return (args as { settings?: unknown })?.settings;
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
function openedJobs(): OpenJob[] {
  const seen: OpenJob[] = [];
  window.addEventListener(OPEN_JOB, (e) => seen.push((e as CustomEvent<OpenJob>).detail));
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
    const tabs = openedJobs();
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
  // Signing out is the control; removing rides its dialog. Where the adapter
  // declares no logout there is nothing to sign out of, so the control is the
  // removal itself.
  it("offers removal only through the sign-out control", async () => {
    const { container, queryByRole, getByRole } = await open(mount({
      accounts: {
        profiles: [profile(), profile({ id: "work", label: "Work", isDefault: false, home: "/h/w" })],
      },
    }));
    await waitFor(() => expect(container.textContent).toContain("Work"));
    expect(queryByRole("button", { name: /Sign out and remove/ })).toBeNull();
    expect(getByRole("button", { name: "Sign Work out" })).toBeTruthy();
  });

  it("removes directly when the agent has no logout command", async () => {
    const { container, getByRole } = await open(mount({
      accounts: {
        canSignOut: false,
        profiles: [profile({ id: "work", label: "Work", isDefault: false, home: "/h/w" })],
      },
    }));
    await waitFor(() => expect(container.textContent).toContain("Work"));
    expect(getByRole("button", { name: "Remove Work" })).toBeTruthy();
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

  // Isolation is measured, never inferred from having a home variable. Where
  // it is unmeasured there is simply no add button: the sentence explaining
  // why is maintainer bookkeeping and lives in ADAPTERS.md, not in the app.
  it("offers no add button for a agent with no measured isolation", async () => {
    const { container, queryByText } = await open(mount({ accounts: { canAdd: false } }));
    await waitFor(() => expect(container.textContent).toContain("Accounts"));
    expect(queryByText("Add account")).toBeNull();
    expect(container.textContent).not.toContain("two accounts at once");
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
    const tabs = openedJobs();
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
    const tabs = openedJobs();
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

  it("asks first, then signs out through the agent's own logout command", async () => {
    const { container, getByRole } = await open(mount());
    await waitFor(() => expect(container.textContent).toContain("Accounts"));

    fireEvent.click(getByRole("button", { name: "Sign Default out" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

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
    expect(queryByRole("button", { name: /Sign Default out/ })).toBeNull();
  });

  // The checkbox is the old "Sign out and remove" button: same call, asked
  // where the consequence is written down.
  it("removes as well when the dialog's checkbox is ticked", async () => {
    const { container, getByRole } = await open(mount({
      accounts: {
        profiles: [profile(), profile({ id: "work", label: "Work", isDefault: false, home: "/h/w" })],
      },
    }));
    await waitFor(() => expect(container.textContent).toContain("Work"));

    fireEvent.click(getByRole("button", { name: "Sign Work out" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Remove the account as well/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() =>
      expect(
        invoked.mock.calls.some(
          ([cmd, args]) =>
            cmd === "remove_agent_account" &&
            (args as { profileId?: string })?.profileId === "work",
        ),
      ).toBe(true),
    );
    expect(invoked.mock.calls.some(([cmd]) => cmd === "sign_out_agent_account")).toBe(false);
  });
});

// The third layer of the defaults chain, and the only one with a control: a
// project's own memory answers first, this answers when it has none, and the
// login the user already had answers when neither does.
describe("which account new sessions start on", () => {
  beforeEach(() => invoked.mockReset());

  const two = {
    profiles: [
      profile(),
      profile({ id: "fonn", label: "Fonn", isDefault: false, home: "/h/fonn", account: "a@fonn" }),
    ],
  };

  // "Which of these" is a question about two things. With one account there is
  // nothing to pick between, and a lone checked radio would be a control whose
  // every state is the same state.
  it("asks nothing on an install with one account", async () => {
    const { container, queryAllByRole } = await open(mount());
    await waitFor(() => expect(container.textContent).toContain("Accounts"));
    expect(queryAllByRole("radio")).toHaveLength(0);
  });

  // Named after the account rather than "Default" three times over: the label
  // is what a reader hears, and it has to say which row it is on.
  it("offers one per account, on the inherited login until told otherwise", async () => {
    const { container, getByRole } = await open(mount({ accounts: two }));
    await waitFor(() => expect(container.textContent).toContain("Fonn"));
    expect((getByRole("radio", { name: "Default account: Default" }) as HTMLInputElement).checked).toBe(true);
    expect((getByRole("radio", { name: "Default account: Fonn" }) as HTMLInputElement).checked).toBe(false);
  });

  it("stores the account it is moved to", async () => {
    const { container, getByRole } = await open(mount({ accounts: two }));
    await waitFor(() => expect(container.textContent).toContain("Fonn"));

    fireEvent.click(getByRole("radio", { name: "Default account: Fonn" }));

    await waitFor(() => {
      const saved = invoked.mock.calls.find(([cmd]) => cmd === "set_settings")?.[1] as
        | { settings: { agent: { defaultProfiles: Record<string, string> } } }
        | undefined;
      expect(saved?.settings.agent.defaultProfiles).toEqual({ claude: "fonn" });
    });
  });
});

// Two logins of one binary can be on different plans and offer different
// models, which is the whole reason the catalogue is keyed per account. The
// rows are where that becomes visible.
describe("what each account can run", () => {
  beforeEach(() => invoked.mockReset());

  it("names the plan and the count from that account's own catalogue", async () => {
    const { container } = await open(
      mount({
        accounts: {
          profiles: [
            profile(),
            profile({ id: "fonn", label: "Fonn", isDefault: false, home: "/h/fonn" }),
          ],
        },
        catalogs: [
          catalogue("default", "max", ["opus", "sonnet", "haiku", "fable", "default"]),
          catalogue("fonn", "team", ["opus", "sonnet", "haiku", "default"]),
        ],
      }),
    );
    await waitFor(() => expect(container.textContent).toContain("max, 5 models"));
    expect(container.textContent).toContain("team, 4 models");
  });

  // A count is a claim about what a probe answered, so an account nobody has
  // asked says nothing rather than "0 models".
  it("says nothing for an account nothing has asked", async () => {
    const { container } = await open(mount());
    await waitFor(() => expect(container.textContent).toContain("Accounts"));
    // Read off the row itself: the page below it has a Models section of its
    // own, so the whole card's text cannot tell the two apart.
    const row = container.querySelector(`.${styles.accountRow}`);
    // Asserted first, or the check below is vacuous on a selector that found
    // nothing.
    expect(row?.textContent).toContain("your existing login");
    expect(row?.textContent).not.toContain("model");
  });
});

// The name itself is the control: click it, type, Enter. The default account
// renames too, which is what lets "Default" become "Personal".
describe("renaming an account", () => {
  beforeEach(() => invoked.mockReset());

  const renameTo = (row: HTMLElement, name: string) => {
    fireEvent.click(row);
    const field = screen.getByLabelText(`Rename ${row.textContent}`) as HTMLInputElement;
    fireEvent.input(field, { target: { value: name } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.blur(field);
  };

  const sent = (profileId: string, label: string) =>
    invoked.mock.calls.some(
      ([cmd, args]) =>
        cmd === "rename_agent_account" &&
        (args as { profileId?: string; label?: string })?.profileId === profileId &&
        (args as { label?: string })?.label === label,
    );

  it("sends the new name for an account Sway added", async () => {
    const { container, getByRole } = await open(
      mount({
        accounts: {
          profiles: [
            profile(),
            profile({ id: "fonn", label: "Fonn", isDefault: false, home: "/h/fonn" }),
          ],
        },
      }),
    );
    await waitFor(() => expect(container.textContent).toContain("Fonn"));

    renameTo(getByRole("button", { name: "Fonn" }), "Work");
    await waitFor(() => expect(sent("fonn", "Work")).toBe(true));
  });

  it("renames the login the user already had, and sends nothing for an unchanged name", async () => {
    const { container, getByRole } = await open(mount());
    await waitFor(() => expect(container.textContent).toContain("your existing login"));

    renameTo(getByRole("button", { name: "Default" }), "Default");
    expect(invoked.mock.calls.some(([cmd]) => cmd === "rename_agent_account")).toBe(false);

    renameTo(getByRole("button", { name: "Default" }), "Personal");
    await waitFor(() => expect(sent("default", "Personal")).toBe(true));
  });
});
