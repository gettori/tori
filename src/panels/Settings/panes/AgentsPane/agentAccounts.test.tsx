// The accounts half of an agent card, end to end through the component.
//
// Everything on this screen came out of the agent's own probe, and the tests
// keep it that way: nothing asserts on a credential, because on macOS there is
// no credential to assert on. Phase 0 measured that `claude` keeps its tokens in
// the login Keychain, so a profile home holds nothing secret.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, waitFor, fireEvent, screen } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import AgentsSection from "./AgentsSection";
import { __resetModelCatalogsForTests, type ModelCatalog } from "../../../../utils/modelCatalog";
import { resetUsageStoreForTests, seedUsageStoreForTests } from "../../../../utils/usageStore";
import { DEFAULT_SETTINGS, applySettings } from "../../settingsStore";
import { OPEN_JOB, type OpenJob } from "../../../../utils/events";
import styles from "../../Settings.module.css";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/home/me" }));
const invoked = vi.mocked(invoke);

// Claude's `[usage]` table. The fallback adapter this harness paints from
// carries none, and without one the card has no windows to offer: the chips
// under test would not exist at all.
vi.mock("../../../../utils/agents", async (orig) => {
  const actual = await orig<typeof import("../../../../utils/agents")>();
  return {
    ...actual,
    findAdapter: (id: string) => {
      const a = actual.findAdapter(id);
      return id === "claude" ? { ...a, usage: { sources: ["sessions", "token"] } } : a;
    },
  };
});

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
  managed: false,
  signIn: "signedIn",
  account: "a@b.c",
  apiKeySource: null,
  duplicateOf: null,
  command: "claude",
  login: { type: "terminal", program: "claude", args: ["auth", "login"], home: null },
  ...over,
});

const view = (over: Record<string, unknown> = {}) => ({
  adapterId: "claude",
  declared: true,
  canAdd: true,
  canSignOut: true,
  defaultPresent: true,
  program: "claude",
  commandDir: "/home/me/.local/bin",
  commandDirOnPath: true,
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
    if (cmd === "agent_health" || cmd === "refresh_agent_health") return [health(over.health)];
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

/** Every account card arrives closed. This opens one, for the tests that read
 *  its body. */
async function expand(r: ReturnType<typeof render>, label = "Default") {
  const toggle = await r.findByRole("button", { name: `Expand ${label}` });
  fireEvent.click(toggle);
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
  // rather than Tori reading its environment and guessing which variables
  // matter to which agent. A notice, never a block.
  it("warns when an inherited key overrides subscription billing", async () => {
    const { container } = await open(
      mount({
        health: { signIn: "signedIn", apiKeySource: "ANTHROPIC_API_KEY" },
      }),
    );
    await waitFor(() => expect(container.textContent).toContain("ANTHROPIC_API_KEY"));
    expect(container.textContent).toContain("rather than the subscription");
    // Still usable: the warning sits beside a working agent rather than in
    // place of one, and the verdict pill keeps saying so.
    expect(container.textContent).toContain("Ready");
  });
});

describe("the accounts list", () => {
  beforeEach(() => invoked.mockReset());

  // The head shows the name alone; where the account lives is on the card, and
  // the default account has no path to put there.
  it("names the default profile as the user's existing login", async () => {
    const r = await open(mount());
    await waitFor(() => expect(r.container.textContent).toContain("Accounts"));
    await expand(r);
    expect(r.container.textContent).toContain("Your existing login");
  });

  it("shows an added account's profile home on its card", async () => {
    const { container, getByRole } = await open(
      mount({
        accounts: {
          profiles: [profile({ id: "work", label: "Work", isDefault: false, home: "/home/me/p/work" })],
        },
      }),
    );
    await waitFor(() => expect(container.textContent).toContain("Work"));
    // A card nobody is signed into on opens closed, so the path is a press
    // away rather than on screen.
    expect(container.textContent).not.toContain("~/p/work");
    fireEvent.click(getByRole("button", { name: "Expand Work" }));
    expect(container.textContent).toContain("~/p/work");
  });

  it("shows the account the agent named for a profile", async () => {
    const { container } = await open(mount());
    await waitFor(() => expect(container.textContent).toContain("a@b.c"));
  });

  // There is nothing stored to remove, and "removing" it could only mean
  // signing the user out of the login they had before Tori existed.
  // Signing out is the control; removing rides its dialog. Where the adapter
  // declares no logout there is nothing to sign out of, so the control is the
  // removal itself.
  it("offers removal only through the sign-out control", async () => {
    const { container, queryByRole, getByRole } = await open(
      mount({
        accounts: {
          profiles: [profile(), profile({ id: "work", label: "Work", isDefault: false, home: "/h/w" })],
        },
      }),
    );
    await waitFor(() => expect(container.textContent).toContain("Work"));
    expect(queryByRole("button", { name: /Sign out and remove/ })).toBeNull();
    fireEvent.click(getByRole("button", { name: "Expand Work" }));
    expect(getByRole("button", { name: "Sign Work out" })).toBeTruthy();
  });

  it("removes directly when the agent has no logout command", async () => {
    const { container, getByRole } = await open(
      mount({
        accounts: {
          canSignOut: false,
          profiles: [profile({ id: "work", label: "Work", isDefault: false, home: "/h/w" })],
        },
      }),
    );
    await waitFor(() => expect(container.textContent).toContain("Work"));
    fireEvent.click(getByRole("button", { name: "Expand Work" }));
    expect(getByRole("button", { name: "Remove Work" })).toBeTruthy();
    expect(container.textContent).toContain("Danger area");
  });

  // Two profiles on one account is a thing somebody may genuinely want, so this
  // says what it sees rather than refusing.
  it("warns about a second profile signed in to the same account", async () => {
    const { container, getByRole } = await open(
      mount({
        accounts: {
          profiles: [profile(), profile({ id: "work", label: "Work", isDefault: false, duplicateOf: "Default" })],
        },
      }),
    );
    await waitFor(() => expect(container.textContent).toContain("Work"));
    fireEvent.click(getByRole("button", { name: "Expand Work" }));
    expect(container.textContent).toContain("same account as Default");
  });

  // Isolation is measured, never inferred from having a home variable. Where
  // it is unmeasured there is simply no add button: the sentence explaining
  // why is maintainer bookkeeping and lives in ADAPTERS.md, not in the app.
  it("offers no add button for a agent with no measured isolation", async () => {
    const { container, queryByRole } = await open(mount({ accounts: { canAdd: false } }));
    await waitFor(() => expect(container.textContent).toContain("Accounts"));
    expect(queryByRole("button", { name: /Add account/ })).toBeNull();
  });

  // "Tori has nothing true to say about this agent's accounts" is not the
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
    const { container, getByText } = await open(
      mount({
        accounts: { profiles: [profile({ signIn: "signedOut" })] },
      }),
    );
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
    const { container, getAllByText } = await open(
      mount({
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
      }),
    );
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
    const { container, getByRole } = await open(mount());
    await waitFor(() => expect(container.textContent).toContain("Accounts"));

    fireEvent.click(getByRole("button", { name: /Add account/ }));
    // The modal portals out of the component's own container.
    const input = await waitFor(() => screen.getByRole("textbox", { name: "Name" }));
    fireEvent.input(input, { target: { value: "Work" } });
    fireEvent.click(screen.getByText("Create and sign in"));

    await waitFor(() => expect(invoked.mock.calls.some((c) => c[0] === "add_agent_account")).toBe(true));
    await waitFor(() => expect(invoked.mock.calls.some((c) => c[0] === "sessions_watch_start")).toBe(true));
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
    const r = await open(mount());
    const { container, getByRole } = r;
    await waitFor(() => expect(container.textContent).toContain("Accounts"));

    // The danger area is in the body, which is a press away.
    await expand(r);
    fireEvent.click(getByRole("button", { name: "Sign Default out" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() =>
      expect(
        invoked.mock.calls.some(
          ([cmd, args]) =>
            cmd === "sign_out_agent_account" && (args as { profileId?: string })?.profileId === "default",
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
    const { container, getByRole } = await open(
      mount({
        accounts: {
          profiles: [profile(), profile({ id: "work", label: "Work", isDefault: false, home: "/h/w", managed: true })],
        },
      }),
    );
    await waitFor(() => expect(container.textContent).toContain("Work"));

    fireEvent.click(getByRole("button", { name: "Expand Work" }));
    fireEvent.click(getByRole("button", { name: "Sign Work out" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Remove the account as well/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() =>
      expect(
        invoked.mock.calls.some(
          ([cmd, args]) => cmd === "remove_agent_account" && (args as { profileId?: string })?.profileId === "work",
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
      profile({ id: "globex", label: "Globex", isDefault: false, home: "/h/globex", account: "a@globex" }),
    ],
  };

  // "Which of these" is a question about two things. With one account there is
  // nothing to pick between, and a lone checked radio would be a control whose
  // every state is the same state.
  it("asks nothing on an install with one account", async () => {
    const { container, queryAllByRole } = await open(mount());
    await waitFor(() => expect(container.textContent).toContain("Accounts"));
    // By name, not by role: the Usage block further down the same page has a
    // radio group of its own, and it is a question about the agent rather than
    // about which account a session starts on.
    expect(queryAllByRole("radio", { name: /^Default account:/ })).toHaveLength(0);
  });

  // Named after the account rather than "Default" three times over: the label
  // is what a reader hears, and it has to say which row it is on.
  it("offers one per account, on the inherited login until told otherwise", async () => {
    const { container, getByRole } = await open(mount({ accounts: two }));
    await waitFor(() => expect(container.textContent).toContain("Globex"));
    expect((getByRole("radio", { name: "Default account: Default" }) as HTMLInputElement).checked).toBe(true);
    expect((getByRole("radio", { name: "Default account: Globex" }) as HTMLInputElement).checked).toBe(false);
  });

  it("stores the account it is moved to", async () => {
    const { container, getByRole } = await open(mount({ accounts: two }));
    await waitFor(() => expect(container.textContent).toContain("Globex"));

    fireEvent.click(getByRole("radio", { name: "Default account: Globex" }));

    await waitFor(() => {
      const saved = invoked.mock.calls.find(([cmd]) => cmd === "set_settings")?.[1] as
        | { settings: { agent: { defaultProfiles: Record<string, string> } } }
        | undefined;
      expect(saved?.settings.agent.defaultProfiles).toEqual({ claude: "globex" });
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
          profiles: [profile(), profile({ id: "globex", label: "Globex", isDefault: false, home: "/h/globex" })],
        },
        catalogs: [
          catalogue("default", "max", ["opus", "sonnet", "haiku", "fable", "default"]),
          catalogue("globex", "team", ["opus", "sonnet", "haiku", "default"]),
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
    const row = container.querySelector(`.${styles.acctCard}`);
    // Asserted first, or the check below is vacuous on a selector that found
    // nothing.
    expect(row?.textContent).toContain("Default");
    // The count, not the word: the card names a "Week / all models" window.
    expect(row?.textContent).not.toMatch(/\d+ models?/);
  });
});

// The quota half of the card. The account is the unit because the window is: a
// five-hour window belongs to a login, so the chips, the threshold and the
// switch are all per account rather than per agent.
describe("the quota on an account card", () => {
  const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
  const win = (kind: string, utilization: number, inSeconds: number) => ({
    kind,
    utilization,
    resetsAt: Math.floor(NOW / 1000) + inSeconds,
    status: null,
    reachedType: null,
  });

  beforeEach(() => {
    invoked.mockReset();
    vi.setSystemTime(NOW);
    resetUsageStoreForTests();
    // The settings store is module state, so without this a test inherits what
    // the last one's chip press wrote. Cloned rather than passed: applying the
    // shared default object hands the store a reference to it.
    applySettings(structuredClone(DEFAULT_SETTINGS));
  });

  /** What the panel last wrote for this account, as the file would hold it. */
  const savedWindows = (id = "default") => {
    const writes = invoked.mock.calls.filter(([cmd]) => cmd === "set_settings");
    const last = writes[writes.length - 1]?.[1] as
      | {
          settings?: {
            agent?: {
              usage?: Record<
                string,
                { accounts?: Record<string, { windows?: string[]; warnAt?: number; notify?: boolean }> }
              >;
            };
          };
        }
      | undefined;
    return last?.settings?.agent?.usage?.claude?.accounts?.[id];
  };

  it("draws a box per window, with the level and when it empties", async () => {
    seedUsageStoreForTests("claude", null, [win("five_hour", 0.128, 4 * 3600 + 34 * 60)], NOW);
    const { container } = await expand(await open(mount()));
    await waitFor(() => expect(container.textContent).toContain("5h rolling"));
    expect(container.textContent).toContain("12.8%");
    // A countdown while the window is close enough to plan around.
    expect(container.textContent).toContain("4h 34m left");
    // And a box for the window nothing has answered for yet, rather than a gap.
    expect(container.textContent).toContain("all models");
    expect(container.textContent).toContain("not read yet");
  });

  it("shows the two free windows on the titlebar and keeps the model one off", async () => {
    const { getByRole } = await expand(await open(mount()));
    await waitFor(() => expect(getByRole("button", { name: /^5H$/ })).toBeTruthy());
    expect(getByRole("button", { name: /^5H$/ }).getAttribute("aria-pressed")).toBe("true");
    expect(getByRole("button", { name: /^Week$/ }).getAttribute("aria-pressed")).toBe("true");
    expect(getByRole("button", { name: /^Model/ }).getAttribute("aria-pressed")).toBe("false");
  });

  it("stores the whole list when a chip is pressed, not just the chip", async () => {
    const { getByRole } = await expand(await open(mount()));
    await waitFor(() => expect(getByRole("button", { name: /^Week$/ })).toBeTruthy());

    fireEvent.click(getByRole("button", { name: /^Week$/ }));
    await waitFor(() => expect(savedWindows()?.windows).toEqual(["five_hour"]));
  });

  // The chip is the permission. The stored list is what the backend's own gate
  // reads before it opens the login Keychain, so lighting it here is the whole
  // of the opt-in.
  it("asks for the model window by storing the chip that authorises the read", async () => {
    const { container, getByRole } = await expand(await open(mount()));
    // Nothing knows which model this account's week is scoped to until a read
    // lands, and the card says that rather than guessing a name.
    await waitFor(() => expect(getByRole("button", { name: /^Model/ })).toBeTruthy());
    expect(container.textContent).toContain("one model");
    expect(container.textContent).toContain("needs the account token");

    fireEvent.click(getByRole("button", { name: /^Model/ }));
    // The chip's own effect. That the rest of the list comes with it is the
    // test above; what matters here is that the one key the backend gate reads
    // is now in the file.
    await waitFor(() => expect(savedWindows()?.windows).toContain("model_week"));
  });

  // Once a read has landed the chip stops asking and starts naming: the model
  // comes from the window itself, which is the only thing that knows it.
  it("names the model window after the model once one has answered", async () => {
    seedUsageStoreForTests("claude", null, [{ ...win("seven_day_fable", 0.032, 3 * 86400), source: "token" }], NOW);
    const { container, getByRole } = await expand(await open(mount()));
    await waitFor(() => expect(container.textContent).toContain("Fable only"));
    expect(getByRole("button", { name: /^Fable$/ })).toBeTruthy();
    expect(container.textContent).not.toContain("needs the account token");
  });

  // The endpoint scopes a week to things that are not models, and those used to
  // ride into the titlebar on the model chip: turning Fable on turned overage on
  // with it, and nothing could separate them.
  it("gives a week scoped to something other than a model its own chip", async () => {
    seedUsageStoreForTests(
      "claude",
      null,
      [win("seven_day_fable", 0.28, 3 * 86400), win("seven_day_overage_included", 0.28, 3 * 86400)],
      NOW,
    );
    const { container, getByRole } = await expand(await open(mount()));

    await waitFor(() => expect(getByRole("button", { name: /^Fable$/ })).toBeTruthy());
    const model = getByRole("button", { name: /^Fable$/ });
    const held = model.getAttribute("aria-pressed");
    const other = getByRole("button", { name: /^Overage included$/ });
    // Off until it is asked for, and named as the qualifier it is rather than
    // as a model. Its card is on the screen either way.
    expect(other.getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).toContain("overage included");

    fireEvent.click(other);

    await waitFor(() => expect(savedWindows()?.windows).toContain("week_other"));
    // And the model chip is where it was, which is the whole point of the split.
    expect(model.getAttribute("aria-pressed")).toBe(held);
  });

  it("moves this account's own threshold, in the shared control's stops", async () => {
    const { container, getByRole } = await expand(await open(mount()));
    await waitFor(() => expect(container.textContent).toContain("Warn at"));

    fireEvent.click(getByRole("button", { name: "Warn earlier" }));
    await waitFor(() => expect(savedWindows()?.warnAt).toBeCloseTo(0.75));
    // And the summary on the head is the same number, so a closed card still
    // says what it will warn at.
    await waitFor(() => expect(container.textContent).toContain("75%"));
  });

  it("keeps the notification switch per account", async () => {
    const { getByRole } = await expand(await open(mount()));
    await waitFor(() => expect(getByRole("switch", { name: /Notify about Default/ })).toBeTruthy());

    fireEvent.click(getByRole("switch", { name: /Notify about Default/ }));
    await waitFor(() => expect(savedWindows()?.notify).toBe(false));
  });

  // An agent whose adapter declares no ladder gets no chips and no threshold,
  // because there would be nothing behind them.
  it("says so plainly for an agent Tori can read no quota for", async () => {
    const { container, queryByRole } = await expand(
      await open(mount({ health: { id: "codex", label: "Codex", program: "codex" } }), "Codex"),
    );
    await waitFor(() => expect(container.textContent).toContain("Tori reads no quota for Codex"));
    expect(queryByRole("button", { name: /^5H$/ })).toBeNull();
  });
});

// The name opens the rename dialog. The default account renames too, which is
// what lets "Default" become "Personal".
describe("renaming an account", () => {
  beforeEach(() => invoked.mockReset());

  const globex = () =>
    profile({ id: "globex", label: "Globex", isDefault: false, home: "/h/globex", command: "claude-globex" });

  const typeName = (row: HTMLElement, name: string) => {
    fireEvent.click(row);
    const field = screen.getByLabelText("Name") as HTMLInputElement;
    fireEvent.input(field, { target: { value: name } });
    return field;
  };
  const renameTo = (row: HTMLElement, name: string) => {
    typeName(row, name);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  };

  const sentWith = (profileId: string, label: string) =>
    invoked.mock.calls.find(
      ([cmd, args]) =>
        cmd === "rename_agent_account" &&
        (args as { profileId?: string; label?: string })?.profileId === profileId &&
        (args as { label?: string })?.label === label,
    )?.[1] as { renameCommand?: boolean } | undefined;

  it("sends the new name for an account Tori added, with the command following", async () => {
    const { container, getByRole } = await open(mount({ accounts: { profiles: [profile(), globex()] } }));
    await waitFor(() => expect(container.textContent).toContain("Globex"));

    typeName(getByRole("button", { name: "Globex" }), "Work");
    expect(screen.getByText("Also rename command to claude-work")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(sentWith("globex", "Work")?.renameCommand).toBe(true));
    // And the page re-reads its own copy of the sweep, or the Models tabs keep
    // the old name until Settings is closed and reopened.
    await waitFor(() => expect(invoked.mock.calls.filter(([cmd]) => cmd === "agent_health").length).toBeGreaterThan(1));
  });

  it("keeps the old command when the box is unchecked", async () => {
    const { container, getByRole } = await open(mount({ accounts: { profiles: [profile(), globex()] } }));
    await waitFor(() => expect(container.textContent).toContain("Globex"));

    typeName(getByRole("button", { name: "Globex" }), "Work");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(sentWith("globex", "Work")?.renameCommand).toBe(false));
  });

  it("offers no command box for the default account or a name with the same command", async () => {
    const { container, getByRole } = await open(mount({ accounts: { profiles: [profile(), globex()] } }));
    await waitFor(() => expect(container.textContent).toContain("Globex"));

    typeName(getByRole("button", { name: "Default" }), "Personal");
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    typeName(getByRole("button", { name: "Globex" }), "GLOBEX");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("changes nothing on Cancel", async () => {
    const { container, getByRole } = await open(mount({ accounts: { profiles: [profile(), globex()] } }));
    await waitFor(() => expect(container.textContent).toContain("Globex"));

    typeName(getByRole("button", { name: "Globex" }), "Work");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(invoked.mock.calls.some(([cmd]) => cmd === "rename_agent_account")).toBe(false);
  });

  it("renames the login the user already had, and sends nothing for an unchanged name", async () => {
    const { container, getByRole } = await expand(await open(mount()));
    await waitFor(() => expect(container.textContent).toContain("Accounts"));

    renameTo(getByRole("button", { name: "Default" }), "Default");
    expect(invoked.mock.calls.some(([cmd]) => cmd === "rename_agent_account")).toBe(false);

    renameTo(getByRole("button", { name: "Default" }), "Personal");
    await waitFor(() => expect(sentWith("default", "Personal")?.renameCommand).toBe(false));
  });
});

describe("the command an account runs as", () => {
  beforeEach(() => invoked.mockReset());

  const two = (over: Record<string, unknown> = {}) => ({
    profiles: [
      profile(),
      profile({ id: "work", label: "Work", isDefault: false, home: "/h/work", command: "claude-work" }),
    ],
    ...over,
  });

  it("shows plain claude on the default account and the named command on an added one", async () => {
    const r = await open(mount({ accounts: two() }));
    await expand(r);
    await expand(r, "Work");
    await waitFor(() => expect(r.container.textContent).toContain("claude-work"));
    const commands = [...r.container.querySelectorAll(`.${styles.acctCommand} code`)].map((c) => c.textContent);
    expect(commands).toEqual(["claude", "claude-work"]);
    expect(r.container.textContent).not.toContain("is not on your shell's PATH");
  });

  it("says when the command folder is off the login PATH", async () => {
    const r = await open(mount({ accounts: two({ commandDirOnPath: false }) }));
    await expand(r, "Work");
    await waitFor(() => expect(r.container.textContent).toContain("~/.local/bin is not on your shell's PATH"));
  });

  it("says plain claude runs the inherited folder only when one is inherited", async () => {
    const r = await open(mount({ accounts: two() }));
    await expand(r);
    await waitFor(() => expect(r.container.textContent).toContain("claude"));
    expect(r.container.textContent).not.toContain("If your shell exports it too");

    const inherited = await open(mount({ accounts: two({ inheritedHome: "/h/work" }) }));
    await expand(inherited);
    await waitFor(() => expect(inherited.container.textContent).toContain("If your shell exports it too"));
  });
});
