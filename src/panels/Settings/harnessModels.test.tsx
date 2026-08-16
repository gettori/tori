// What a harness offers to pick from, on the card as a count and on its own
// page as a list.
//
// **Every number and every row here came from the harness itself**, on a probe
// `catalog_probe` ran and cached. Nothing is declared: these tests used to
// assert counts read out of `[[chat.models]]`, a TOML that said four models
// regardless of the CLI on the machine and 200k for models the harness reports
// 1M for. The interesting cases are therefore the ones a table could not have:
// a harness nobody has asked, one whose probe failed, and one whose answer
// describes a binary that has since been upgraded.
//
// One adapter list for the whole file, varied by which harness the health sweep
// reports: `ensureAgentsLoaded` fetches once per module and caches, so a
// per-test `list_agents` would answer only the first test and silently reuse it
// for the rest.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import AgentsSection from "./AgentsSection";
import { __resetModelCatalogsForTests } from "../../utils/modelCatalog";
import type { CatalogModel, ModelCatalog, ProbeFailureReason } from "../../utils/modelCatalog";

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
    annotations: [],
    modes: [],
    effort: [],
    acp: { serve_client_fs: false },
  },
  accounts: null,
});

const ADAPTERS = [adapter("claude"), adapter("solo"), adapter("overprotocol")];

const model = (value: string, resolved: string, over: Partial<CatalogModel> = {}): CatalogModel => ({
  value,
  resolvedModel: resolved,
  displayName: value,
  description: "",
  supportsEffort: false,
  supportedEffortLevels: [],
  supportsAutoMode: false,
  ...over,
});

/** A harness that answered, with whatever models the caller names. */
const probed = (
  harnessId: string,
  models: CatalogModel[],
  over: Partial<ModelCatalog["catalogue"] & object> = {},
): ModelCatalog => ({
  harnessId,
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

/** A harness whose most recent attempt failed. `keeping` is a catalogue an
 *  earlier probe left behind, which a failure never clears. */
const failed = (
  harnessId: string,
  reason: ProbeFailureReason,
  detail = "",
  keeping: ModelCatalog["catalogue"] = null,
): ModelCatalog => ({
  harnessId,
  state: "failed",
  catalogue: keeping,
  lastFailure: { reason, detail, atMs: Date.parse("2026-08-15T12:00:00Z") },
});

const neverProbed = (harnessId: string): ModelCatalog => ({
  harnessId,
  state: "neverProbed",
  catalogue: null,
  lastFailure: null,
});

function mount(over: Record<string, unknown> = {}, catalogs: ModelCatalog[] = []) {
  invoked.mockReset();
  __resetModelCatalogsForTests();
  invoked.mockImplementation(async (cmd: string) => {
    if (cmd === "agent_health") return [health(over)];
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
// only where a probe answered, and the three states below are rendered
// differently on purpose: the one that matters most is the first, because "0
// models" for a harness nobody asked reads as a broken install.
describe("how many models a harness offers", () => {
  // Read off the card itself, not the section: the page's own "Check models"
  // button is the thing that would ask for one.
  const card = (container: HTMLElement) =>
    container.querySelector('[data-harness="claude"]')?.textContent ?? "";

  it("claims no count for a harness nothing has asked", async () => {
    const { container } = mount({}, [neverProbed("claude")]);
    await waitFor(() => expect(container.textContent).toContain("Claude"));
    expect(card(container)).not.toContain("model");
  });

  it("counts what the harness named", async () => {
    const { container } = mount({}, [
      probed("claude", [model("sonnet", "claude-sonnet-5"), model("haiku", "claude-haiku-4-5")]),
    ]);
    await waitFor(() => expect(container.textContent).toContain("2 models"));
  });

  // A catalogue names aliases: `default`, `sonnet` and the dated id are three
  // rows and one model. Counting them separately would be counting Sway's
  // ability to spell.
  it("counts a model once however many names the catalogue gives it", async () => {
    const { container } = mount({}, [
      probed("claude", [
        model("default", "claude-sonnet-5"),
        model("sonnet", "claude-sonnet-5"),
        model("claude-sonnet-5", "claude-sonnet-5"),
      ]),
    ]);
    await waitFor(() => expect(container.textContent).toContain("1 model"));
    expect(container.textContent).not.toContain("3 model");
  });

  // The dedupe key falls back to `value` for exactly this row: a user-configured
  // model carries an empty `resolvedModel`, because Sway passes the string to
  // the CLI unresolved. Keying on that field alone collapses every one of them
  // into a single entry.
  it("does not collapse the user's own configured models into one", async () => {
    const { container } = mount({}, [
      probed("claude", [
        model("opusplan", "", { userConfigured: true }),
        model("my-fine-tune", "", { userConfigured: true }),
      ]),
    ]);
    await waitFor(() => expect(container.textContent).toContain("2 models"));
  });

  it("says Error when the last probe failed and there was never an answer", async () => {
    const { container } = mount({}, [failed("claude", "signedOut")]);
    await waitFor(() => expect(container.textContent).toContain("Error"));
  });

  // Stale-but-real beats fresh-but-empty. A signed-out moment must not turn a
  // working list into an error badge; the detail page is where the failure gets
  // explained.
  it("keeps showing the old count when a later probe failed", async () => {
    const kept = probed("claude", [model("sonnet", "claude-sonnet-5")]).catalogue;
    const { container } = mount({}, [failed("claude", "timedOut", "", kept)]);
    await waitFor(() => expect(container.textContent).toContain("1 model"));
    expect(container.textContent).not.toContain("Error");
  });
});

describe("the model list on a harness page", () => {
  it("lists what the harness named, with the id a switch would have to send", async () => {
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

  // Provenance, so the list cannot rot silently: who was asked, which build,
  // and when.
  it("says who was asked, which build, and when", async () => {
    const { container } = await open(
      mount({}, [probed("claude", [model("sonnet", "claude-sonnet-5")])]),
      /Claude/,
    );
    expect(container.textContent).toContain("Asked Claude 2.1.231");
  });

  /** Phase 5's preview: the levers with no control of Sway's own, read from the
   *  same probe rather than only appearing once a chat is open. The three with
   *  bespoke controls are not repeated here - the model list above is already
   *  the model option, rendered properly. */
  it("previews the harness's own options, minus the ones it renders properly", async () => {
    const r = mount({}, [
      probed("claude", [model("sonnet", "claude-sonnet-5")], {
        options: [
          {
            id: "model",
            name: "Model",
            description: "",
            category: "model",
            kind: "select",
            current: "sonnet",
            choices: [],
          },
          {
            id: "web_search",
            name: "Web search",
            description: "Let the agent search the web",
            category: "",
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

  // The answer describes the binary that answered it. A different one is
  // installed now, so the list may have moved and the page says so rather than
  // presenting a remembered answer as a current one.
  it("flags an answer that describes a binary no longer installed", async () => {
    const stale = probed("claude", [model("sonnet", "claude-sonnet-5")], { version: "2.0.0" });
    const { container } = await open(mount({}, [stale]), /Claude/);
    expect(container.textContent).toContain("the list may have moved");
  });

  it("does not flag one that describes the binary that is installed", async () => {
    const { container } = await open(
      mount({}, [probed("claude", [model("sonnet", "claude-sonnet-5")])]),
      /Claude/,
    );
    expect(container.textContent).not.toContain("the list may have moved");
  });

  it("explains an unasked harness rather than showing an empty list", async () => {
    const { container } = await open(mount({}, [neverProbed("claude")]), /Claude/);
    expect(container.textContent).toContain("Nobody has asked Claude");
  });

  // Sway's sentence names the kind of failure; the harness's own words are
  // quoted after it rather than paraphrased.
  it("names the failure and quotes the harness", async () => {
    const { container } = await open(
      mount({}, [failed("claude", "signedOut", "run `claude /login`")]),
      /Claude/,
    );
    expect(container.textContent).toContain("Nobody is signed in");
    expect(container.textContent).toContain("run `claude /login`");
  });

  // `unsupported` is a fact about this build of Sway, so it must not read as the
  // harness being broken: that would send the user to reinstall something that
  // works.
  it("blames Sway rather than the binary for a transport it cannot probe", async () => {
    const { container } = await open(mount({}, [failed("claude", "unsupported")]), /Claude/);
    expect(container.textContent).toContain("Sway cannot ask this harness yet");
  });

  // A catalogue can differ per account (OpenCode's depends on which providers
  // are authenticated), and the probe runs as the default profile. A page
  // showing one list has to say whose answer it is.
  it("says whose answer it is when the harness named an account", async () => {
    const withAccount = probed("claude", [model("sonnet", "claude-sonnet-5")], {
      account: { subscriptionType: "Claude Max", apiProvider: "firstParty", organization: "" },
    });
    const { container } = await open(mount({}, [withAccount]), /Claude/);
    expect(container.textContent).toContain("Claude Max");
    expect(container.textContent).toContain("default profile");
  });

  it("makes no such claim when the harness named none", async () => {
    const { container } = await open(
      mount({}, [probed("claude", [model("sonnet", "claude-sonnet-5")])]),
      /Claude/,
    );
    expect(container.textContent).not.toContain("default profile");
  });

  // Ask again re-probes. Reading the cache would leave the button doing nothing
  // for a harness whose binary reports no version, which is the one case with no
  // other route back to a fresh answer.
  it("re-asks the harness rather than re-reading the cache", async () => {
    const r = await open(mount({}, [neverProbed("claude")]), /Claude/);
    invoked.mockClear();
    fireEvent.click(r.getByRole("button", { name: /Ask again/ }));
    await waitFor(() =>
      expect(invoked.mock.calls.map(([cmd]) => cmd)).toContain("refresh_model_catalog"),
    );
  });
});

// A catalogue probe spawns the harness's binary. `model_catalogs` reads the
// cache and is free; the two `refresh_*` commands are not, and nothing a user
// merely *looks at* may call them. The split exists so a read cannot become a
// probe by accident.
describe("looking at Settings never probes a harness", () => {
  const probes = () =>
    invoked.mock.calls
      .map(([cmd]) => cmd as string)
      .filter((cmd) => cmd.startsWith("refresh_model_catalog"));

  it("issues no probe on open", async () => {
    const { container } = mount({}, [neverProbed("claude")]);
    await waitFor(() => expect(container.textContent).toContain("Claude"));
    expect(probes()).toEqual([]);
  });

  it("issues no probe on opening a harness page either", async () => {
    await open(mount({}, [neverProbed("claude")]), /Claude/);
    expect(probes()).toEqual([]);
  });
});

// Check models is the deliberate version of the same thing: one process per
// harness that has never answered or whose binary changed, asked in parallel so
// one slow agent does not hold the rest empty.
describe("asking every harness at once", () => {
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
        const id = (args as { harnessId?: string })?.harnessId;
        // Claude answers at once, Solo hangs until the test lets it go, and Over
        // Protocol refuses. Three harnesses, three fates, one click.
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

  it("does not ask again for a harness that has already answered", async () => {
    const r = render(() => <AgentsSection />);
    await r.findByRole("button", { name: /Claude/ });
    await clickCheckAll(r);
    await waitFor(() => expect(r.container.textContent).toContain("1 model"));
    resolveSlow(probed("solo", [model("a", "a")]));
    await waitFor(() => expect(r.container.textContent).not.toContain("checking…"));

    const asked = () =>
      invoked.mock.calls.filter(([cmd]) => cmd === "refresh_model_catalog").map(([, a]) => (a as { harnessId?: string })?.harnessId);
    expect(asked()).toEqual(["claude", "solo", "overprotocol"]);

    await clickCheckAll(r);
    // Claude and Solo answered, so neither is due. Over Protocol failed and has
    // never answered, so it still is: a failure is not an answer.
    await waitFor(() => expect(asked()).toEqual(["claude", "solo", "overprotocol", "overprotocol"]));
  });
});
