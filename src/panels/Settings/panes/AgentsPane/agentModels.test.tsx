// What a agent offers to pick from, on the card as a count and on its own
// page as a list.
//
// **Every number and every row here came from the agent itself**, on a probe
// `catalog_probe` ran and cached. Nothing is declared: these tests used to
// assert counts read out of `[[chat.models]]`, a TOML that said four models
// regardless of the CLI on the machine and 200k for models the agent reports
// 1M for. The interesting cases are therefore the ones a table could not have:
// a agent nobody has asked, one whose probe failed, and one whose answer
// describes a binary that has since been upgraded.
//
// One adapter list for the whole file, varied by which agent the health sweep
// reports: `ensureAdaptersLoaded` fetches once per module and caches, so a
// per-test `list_agents` would answer only the first test and silently reuse it
// for the rest.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, waitFor, fireEvent } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import AgentsSection from "./AgentsSection";
import { __resetModelCatalogsForTests } from "../../../../utils/modelCatalog";
import type { CatalogModel, ModelCatalog, ProbeFailureReason } from "../../../../utils/modelCatalog";
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
  hooks: false,
  needsYou: false,
  overridePath: null,
  ...over,
});

const adapter = (id: string) => ({
  id,
  label: id,
  program: id,
  base_args: [],
  yolo_args: [],
  resume_args: [],
  parser_kind: null,
  running_pattern: "",
  pty_quiet_ms: 0,
  chat: {
    program: id,
    transport: "claude_stream_json",
    base_args: [],
    session_id_args: [],
    resume_args: [],
    model_args: [],
    effort_args: [],
    mode_args: [],
    add_dir_args: [],
    modes: [],
    effort: [],
    acp: { serve_client_fs: false },
  },
  accounts: null,
});

const ADAPTERS = [adapter("claude"), adapter("solo"), adapter("overprotocol"), adapter("gemini")];

const model = (value: string, resolved: string, over: Partial<CatalogModel> = {}): CatalogModel => ({
  value,
  resolvedModel: resolved,
  displayName: value,
  description: "",
  supportsEffort: false,
  supportedEffortLevels: [],
  supportsAutoMode: false,
  supportsFastMode: false,
  supportsAdaptiveThinking: false,
  ...over,
});

/** A agent that answered, with whatever models the caller names. */
const probed = (
  agentId: string,
  models: CatalogModel[],
  over: Partial<ModelCatalog["catalogue"] & object> = {},
): ModelCatalog => ({
  agentId,
  profileId: "default",
  state: "probed",
  catalogue: {
    version: "2.1.231",
    probedAtMs: Date.parse("2026-08-14T12:00:00Z"),
    models,
    modes: [],
    account: null,
    ...over,
  },
  lastFailure: null,
});

/** A agent whose most recent attempt failed. `keeping` is a catalogue an
 *  earlier probe left behind, which a failure never clears. */
const failed = (
  agentId: string,
  reason: ProbeFailureReason,
  detail = "",
  keeping: ModelCatalog["catalogue"] = null,
): ModelCatalog => ({
  agentId,
  profileId: "default",
  state: "failed",
  catalogue: keeping,
  lastFailure: { reason, detail, atMs: Date.parse("2026-08-15T12:00:00Z") },
});

const neverProbed = (agentId: string): ModelCatalog => ({
  agentId,
  profileId: "default",
  state: "neverProbed",
  catalogue: null,
  lastFailure: null,
});

function mount(over: Record<string, unknown> = {}, catalogs: ModelCatalog[] = []) {
  invoked.mockReset();
  __resetModelCatalogsForTests();
  invoked.mockImplementation(async (cmd: string) => {
    if (cmd === "agent_health" || cmd === "refresh_agent_health") return [health(over)];
    if (cmd === "list_agents") return ADAPTERS;
    if (cmd === "agent_accounts") return { adapterId: "claude", declared: false, profiles: [] };
    if (cmd === "model_catalogs") return catalogs;
    return [];
  });
  return render(() => <AgentsSection />);
}

const open = async (r: ReturnType<typeof render>, name: RegExp) => {
  fireEvent.click(await r.findByRole("button", { name }));
  await waitFor(() => expect(r.container.textContent).toContain("Chat capabilities"));
  return r;
};

// **A count is a claim about what the installed binary can run.** So it exists
// only where a probe answered, and the states below are rendered differently
// on purpose: the one that matters most is the first, because "0" for a agent
// nobody asked reads as a broken install.
describe("how many models a agent offers", () => {
  // Read off the row's own MODELS cell, not the whole row: the version cell
  // beside it is also digits, so row text cannot tell the two apart.
  const cell = (container: HTMLElement, id = "claude") =>
    container
      .querySelector(`[data-agent="${id}"] .${styles.agentModels}`)
      ?.textContent?.trim() ?? "";

  it("claims no count for a agent nothing has asked", async () => {
    const { container } = mount({}, [neverProbed("claude")]);
    await waitFor(() => expect(container.textContent).toContain("Claude"));
    expect(cell(container)).toBe("-");
  });

  it("counts what the agent named", async () => {
    const { container } = mount({}, [
      probed("claude", [model("sonnet", "claude-sonnet-5"), model("haiku", "claude-haiku-4-5")]),
    ]);
    await waitFor(() => expect(cell(container)).toBe("2"));
  });

  // A catalogue names aliases: `default`, `sonnet` and the dated id are three
  // rows and one model. Counting them separately would be counting Tori's
  // ability to spell.
  it("counts a model once however many names the catalogue gives it", async () => {
    const { container } = mount({}, [
      probed("claude", [
        model("default", "claude-sonnet-5"),
        model("sonnet", "claude-sonnet-5"),
        model("claude-sonnet-5", "claude-sonnet-5"),
      ]),
    ]);
    await waitFor(() => expect(cell(container)).toBe("1"));
  });

  // The dedupe key falls back to `value` for exactly this row: a user-configured
  // model carries an empty `resolvedModel`, because Tori passes the string to
  // the CLI unresolved. Keying on that field alone collapses every one of them
  // into a single entry.
  it("does not collapse the user's own configured models into one", async () => {
    const { container } = mount({}, [
      probed("claude", [
        model("opusplan", "", { userConfigured: true }),
        model("my-fine-tune", "", { userConfigured: true }),
      ]),
    ]);
    await waitFor(() => expect(cell(container)).toBe("2"));
  });

  /** The agent nobody here can measure. No machine in this project has
   *  `gemini` installed, so its catalogue is the never-probed state for real
   *  rather than as a fixture, and the surface has to read as "we have not
   *  asked" rather than as a broken install or an empty list. */
  it("shows a agent nobody can ask as unasked, not as broken", async () => {
    const r = mount(
      { id: "gemini", label: "Gemini", program: "gemini", status: "notFound", version: null, path: null },
      [neverProbed("gemini")],
    );
    await waitFor(() => expect(r.container.textContent).toContain("Gemini"));
    expect(cell(r.container, "gemini")).toBe("-");

    // The page drops the Models section entirely during setup rather than
    // heading a shrug: the steps already say Tori asks once setup finishes,
    // and nothing anywhere reads as an error.
    const { container } = await open(r, /Gemini/);
    expect(container.textContent).toContain("Ready for chat");
    expect(container.textContent).not.toContain("Nobody has asked");
    expect(container.textContent).not.toContain("Error");
  });

  it("says Error when the last probe failed and there was never an answer", async () => {
    const { container } = mount({}, [failed("claude", "signedOut")]);
    await waitFor(() => expect(cell(container)).toBe("Error"));
  });

  // Stale-but-real beats fresh-but-empty. A signed-out moment must not turn a
  // working list into an error badge; the detail page is where the failure gets
  // explained.
  it("keeps showing the old count when a later probe failed", async () => {
    const kept = probed("claude", [model("sonnet", "claude-sonnet-5")]).catalogue;
    const { container } = mount({}, [failed("claude", "timedOut", "", kept)]);
    await waitFor(() => expect(cell(container)).toBe("1"));
    expect(container.textContent).not.toContain("Error");
  });
});

describe("the model list on a agent page", () => {
  it("lists what the agent named, with the id a switch would have to send", async () => {
    const r = mount({}, [
      probed("claude", [
        model("sonnet", "claude-sonnet-5", {
          displayName: "Sonnet 5",
          supportsEffort: true,
          supportedEffortLevels: ["low", "high"],
        }),
      ]),
    ]);
    const { container } = await open(r, /Claude/);
    expect(container.textContent).toContain("Sonnet 5");
    expect(container.textContent).toContain("sonnet");
    expect(container.textContent).toContain("low · high");
  });

  /** Phase 5's preview: the levers with no control of Tori's own, read from the
   *  same probe rather than only appearing once a chat is open. The three with
   *  bespoke controls are not repeated here - the model list above is already
   *  the model option, rendered properly. */
  it("previews the agent's own options, minus the ones it renders properly", async () => {
    const r = mount({}, [
      probed("claude", [model("sonnet", "claude-sonnet-5")], {
        options: [
          {
            id: "model",
            name: "Model",
            description: "",
            category: "model",
            disabled: false,
            note: "",
            kind: "select",
            current: "sonnet",
            choices: [],
          },
          {
            id: "web_search",
            name: "Web search",
            description: "Let the agent search the web",
            category: "",
            disabled: false,
            note: "",
            kind: "boolean",
            value: true,
          },
        ],
      }),
    ]);
    const { container } = await open(r, /Claude/);
    expect(container.textContent).toContain("Web search");
    expect(container.textContent).toContain("Let the agent search the web");
    // Its state, in the agent's own terms, and read-only: there is no session
    // on this page to set it on.
    expect(container.textContent).toContain("on");
    // Two lists on the page: the models, then the options. The model *option*
    // is not repeated in the second, because the first is already it.
    const lists = container.querySelectorAll("ul");
    expect(lists).toHaveLength(2);
    expect(lists[1].children).toHaveLength(1);
  });

  /** A lever the agent has and will not take reads the same here as in a chat:
   *  shown with its reason, rather than left off the list to be wondered at. */
  it("previews a refused lever with the reason it was refused", async () => {
    const r = mount({}, [
      probed("claude", [model("sonnet", "claude-sonnet-5")], {
        options: [
          {
            id: "fast_mode",
            name: "Fast mode",
            description: "",
            category: "",
            disabled: true,
            note: "Fast mode is not available in the Agent SDK",
            kind: "boolean",
            value: false,
          },
        ],
      }),
    ]);
    const { container } = await open(r, /Claude/);

    expect(container.textContent).toContain("Fast mode");
    expect(container.textContent).toContain("Fast mode is not available in the Agent SDK");
  });

  /** Padding rows that no test query matches ("snt", "xhigh", "zzz" all need
   *  letters "filler-n" does not have), pushing a fixture past the
   *  eight-row threshold where the search box exists at all. */
  const fillers = Array.from({ length: 8 }, (_, i) => model(`filler-${i}`, `filler-${i}`));

  // No search over a list that fits whole: eight rows is the card's height
  // cap, so the box appears exactly when something is off screen to find.
  it("offers no filter for a list of eight or fewer", async () => {
    const r = mount({}, [probed("claude", [model("sonnet", "claude-sonnet-5")])]);
    const { container, queryByLabelText } = await open(r, /Claude/);
    expect(container.textContent).toContain("sonnet");
    expect(queryByLabelText("Filter models")).toBeNull();
  });

  // The filter is the shared fuzzy walk, run against only what the row shows
  // (name, id, effort - never resolvedModel), and the marks land on exactly
  // the characters that earned the match.
  it("filters fuzzily and marks only what matched", async () => {
    const r = mount({}, [
      probed("claude", [
        model("sonnet", "claude-sonnet-5", { displayName: "Sonnet 5" }),
        ...fillers,
      ]),
    ]);
    const { container, getByLabelText } = await open(r, /Claude/);

    fireEvent.input(getByLabelText("Filter models"), { target: { value: "snt" } });

    await waitFor(() => expect(container.textContent).not.toContain("filler-0"));
    expect(container.textContent).toContain("Sonnet 5");
    // The counter says it is a filter, not a shorter answer.
    expect(container.textContent).toContain("1 of 9");
    // Both the name and the id matched, so each carries the query's letters
    // as marks - s, n, t twice, in the display's own casing - and nothing
    // else is marked.
    const marked = [...container.querySelectorAll("mark")].map((el) => el.textContent).join("");
    expect(marked).toBe("Sntsnt");
  });

  it("keeps a row whose only match is its effort ladder", async () => {
    const r = mount({}, [
      probed("claude", [
        model("sonnet", "claude-sonnet-5", {
          displayName: "Sonnet",
          supportsEffort: true,
          supportedEffortLevels: ["low", "xhigh"],
        }),
        ...fillers,
      ]),
    ]);
    const { container, getByLabelText } = await open(r, /Claude/);

    fireEvent.input(getByLabelText("Filter models"), { target: { value: "xhigh" } });

    await waitFor(() => expect(container.textContent).not.toContain("filler-0"));
    expect(container.textContent).toContain("Sonnet");
    const marked = [...container.querySelectorAll("mark")].map((el) => el.textContent).join("");
    expect(marked).toBe("xhigh");
  });

  it("says so when the filter matches nothing", async () => {
    const r = mount({}, [
      probed("claude", [model("sonnet", "claude-sonnet-5"), ...fillers]),
    ]);
    const { container, getByLabelText } = await open(r, /Claude/);

    fireEvent.input(getByLabelText("Filter models"), { target: { value: "zzz" } });

    await waitFor(() => expect(container.textContent).toContain('No model matches "zzz"'));
    expect(container.textContent).toContain("0 of 9");
  });

  // The page carries no footnotes under the list any more - not the probe
  // date, not staleness, not the account it answered for. The rows are the
  // answer; this pins the silence so the messages do not creep back.
  it("puts nothing below the list, even for a stale or per-account answer", async () => {
    const stale = probed("claude", [model("sonnet", "claude-sonnet-5")], {
      version: "2.0.0",
      account: { subscriptionType: "Claude Max", apiProvider: "firstParty", organization: "" },
    });
    const { container } = await open(mount({}, [stale]), /Claude/);
    expect(container.textContent).toContain("sonnet");
    expect(container.textContent).not.toContain("the list may have moved");
    expect(container.textContent).not.toContain("Claude Max");
    expect(container.textContent).not.toContain("Asked Claude");
  });

  // A catalogue is an account's answer and not an agent's, so an agent with
  // two logins has two lists. Which is also why the plan comes back on this
  // page after being dropped as a footnote: over one list it said nothing,
  // over two it is what tells them apart.
  const twoAccounts = {
    profiles: [
      { id: "default", label: "Default", signIn: "signedIn", account: "me@example.com", apiKeySource: null },
      { id: "globex", label: "Globex", signIn: "signedIn", account: "arif@globex.test", apiKeySource: null },
    ],
  };
  const onPlan = (plan: string) => ({
    account: { subscriptionType: plan, apiProvider: "firstParty", organization: "" },
  });

  it("gives each account its own list, one tab at a time", async () => {
    const r = await open(
      mount(twoAccounts, [
        probed("claude", [model("opus", "claude-opus-5")], onPlan("Claude Max")),
        {
          ...probed("claude", [model("sonnet", "claude-sonnet-5")], onPlan("Claude Team")),
          profileId: "globex",
        },
      ]),
      /Claude/,
    );

    // Both accounts are named; the lit one is the list on screen.
    expect(r.getByRole("button", { name: "Default", pressed: true })).toBeTruthy();
    expect(r.getByRole("button", { name: "Globex", pressed: false })).toBeTruthy();
    expect(r.container.textContent).toContain("Claude Max, 1 of 1");
    expect(r.container.textContent).toContain("opus");
    expect(r.container.textContent).not.toContain("sonnet");

    fireEvent.click(r.getByRole("button", { name: "Globex" }));

    await waitFor(() => expect(r.container.textContent).toContain("Claude Team, 1 of 1"));
    expect(r.container.textContent).toContain("sonnet");
    expect(r.container.textContent).not.toContain("opus");
  });

  // The account is what a probe is about, so Ask again on one list must not
  // re-probe the other. The pane that asked is the pane that answers.
  it("asks again for the account whose tab is open", async () => {
    const r = await open(
      mount(twoAccounts, [
        probed("claude", [model("opus", "claude-opus-5")]),
        { ...probed("claude", [model("sonnet", "claude-sonnet-5")]), profileId: "globex" },
      ]),
      /Claude/,
    );
    fireEvent.click(r.getByRole("button", { name: "Globex" }));
    invoked.mockClear();
    fireEvent.click(r.getByRole("button", { name: /Ask again/ }));

    await waitFor(() =>
      expect(
        invoked.mock.calls.filter(([cmd]) => cmd === "refresh_model_catalog"),
      ).toHaveLength(1),
    );
    expect(invoked.mock.calls.find(([cmd]) => cmd === "refresh_model_catalog")?.[1]).toEqual({
      agentId: "claude",
      profileId: "globex",
    });
  });

  it("explains an unasked agent rather than showing an empty list", async () => {
    const { container } = await open(mount({}, [neverProbed("claude")]), /Claude/);
    expect(container.textContent).toContain("Nobody has asked Claude");
  });

  // Tori's sentence names the kind of failure; the agent's own words are
  // quoted after it rather than paraphrased.
  it("names the failure and quotes the agent", async () => {
    const { container } = await open(
      mount({}, [failed("claude", "signedOut", "run `claude /login`")]),
      /Claude/,
    );
    expect(container.textContent).toContain("Nobody is signed in");
    expect(container.textContent).toContain("run `claude /login`");
  });

  // `unsupported` is a fact about this build of Tori, so it must not read as the
  // agent being broken: that would send the user to reinstall something that
  // works.
  it("blames Tori rather than the binary for a transport it cannot probe", async () => {
    const { container } = await open(mount({}, [failed("claude", "unsupported")]), /Claude/);
    expect(container.textContent).toContain("Tori cannot ask this agent yet");
  });

  // Ask again re-probes. Reading the cache would leave the button doing nothing
  // for a agent whose binary reports no version, which is the one case with no
  // other route back to a fresh answer.
  it("re-asks the agent rather than re-reading the cache", async () => {
    const r = await open(mount({}, [neverProbed("claude")]), /Claude/);
    invoked.mockClear();
    fireEvent.click(r.getByRole("button", { name: /Ask again/ }));
    await waitFor(() =>
      expect(invoked.mock.calls.map(([cmd]) => cmd)).toContain("refresh_model_catalog"),
    );
  });
});

// A catalogue probe spawns the agent's binary. `model_catalogs` reads the
// cache and is free; the two `refresh_*` commands are not, and nothing a user
// merely *looks at* may call them. The split exists so a read cannot become a
// probe by accident.
describe("looking at Settings never probes a agent", () => {
  const probes = () =>
    invoked.mock.calls
      .map(([cmd]) => cmd as string)
      .filter((cmd) => cmd.startsWith("refresh_model_catalog"));

  it("issues no probe on open", async () => {
    const { container } = mount({}, [neverProbed("claude")]);
    await waitFor(() => expect(container.textContent).toContain("Claude"));
    expect(probes()).toEqual([]);
  });

  it("issues no probe on opening a agent page either", async () => {
    await open(mount({}, [neverProbed("claude")]), /Claude/);
    expect(probes()).toEqual([]);
  });
});

// Check models is the deliberate version of the same thing: one process per
// agent that has never answered or whose binary changed, asked in parallel so
// one slow agent does not hold the rest empty.
//
// Skipped while the button that starts it is parked (see the section title in
// `AgentsSection.tsx`). `refreshDueCatalogs` is untouched and these still
// describe it, so they come back with the control rather than being rewritten.
describe.skip("asking every agent at once", () => {
  let resolveSlow: (c: ModelCatalog) => void;

  beforeEach(() => {
    invoked.mockReset();
    __resetModelCatalogsForTests();
    invoked.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "agent_health") {
        return [
          health(),
          health({ id: "solo", label: "Solo", program: "solo", version: "1.0.0" }),
          health({ id: "overprotocol", label: "Over Protocol", program: "op", version: "1.0.0" }),
        ];
      }
      if (cmd === "list_agents") return ADAPTERS;
      if (cmd === "agent_accounts") return { adapterId: "claude", declared: false, profiles: [] };
      if (cmd === "model_catalogs") {
        return [neverProbed("claude"), neverProbed("solo"), neverProbed("overprotocol")];
      }
      if (cmd === "refresh_model_catalog") {
        const id = (args as { agentId?: string })?.agentId;
        // Claude answers at once, Solo hangs until the test lets it go, and Over
        // Protocol refuses. Three agents, three fates, one click.
        if (id === "claude") return probed("claude", [model("sonnet", "claude-sonnet-5")]);
        if (id === "overprotocol") return failed("overprotocol", "spawnFailed");
        return new Promise<ModelCatalog>((resolve) => (resolveSlow = resolve));
      }
      return [];
    });
  });

  const clickCheckAll = async (r: ReturnType<typeof render>) => {
    fireEvent.click(await r.findByRole("button", { name: /Check models/ }));
  };

  it("fills each row as its own answer lands rather than waiting for the slowest", async () => {
    const r = render(() => <AgentsSection />);
    await r.findByRole("button", { name: /Claude/ });
    await clickCheckAll(r);

    // The fast one is on screen while the slow one is still out.
    await waitFor(() => expect(r.container.textContent).toContain("1 model"));
    expect(r.container.textContent).toContain("checking…");
    // And a refusal is that row's error, not everybody's wait.
    await waitFor(() => expect(r.container.textContent).toContain("Error"));

    resolveSlow(probed("solo", [model("a", "a"), model("b", "b")]));
    await waitFor(() => expect(r.container.textContent).toContain("2 models"));
  });

  it("does not ask again for a agent that has already answered", async () => {
    const r = render(() => <AgentsSection />);
    await r.findByRole("button", { name: /Claude/ });
    await clickCheckAll(r);
    await waitFor(() => expect(r.container.textContent).toContain("1 model"));
    resolveSlow(probed("solo", [model("a", "a")]));
    await waitFor(() => expect(r.container.textContent).not.toContain("checking…"));

    const asked = () =>
      invoked.mock.calls.filter(([cmd]) => cmd === "refresh_model_catalog").map(([, a]) => (a as { agentId?: string })?.agentId);
    expect(asked()).toEqual(["claude", "solo", "overprotocol"]);

    await clickCheckAll(r);
    // Claude and Solo answered, so neither is due. Over Protocol failed and has
    // never answered, so it still is: a failure is not an answer.
    await waitFor(() => expect(asked()).toEqual(["claude", "solo", "overprotocol", "overprotocol"]));
  });
});
