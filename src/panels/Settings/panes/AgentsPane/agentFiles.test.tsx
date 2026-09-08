// The Files half of an agent card: the files the adapter says this agent reads
// out of each of its account homes.
//
// Two rules run through every test here. **The backend owns the paths**: a row
// renders what `agent_config_files` resolved and never joins a home to a path
// itself, because the default account's home is `#[serde(skip)]` and the
// frontend cannot see it. And **a root is required to open anything**: Settings
// is a modal with no Selection, so it is handed one, and every action that ends
// in an editor tab is off without it and says why.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent, screen } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import AgentsSection from "./AgentsSection";
import { __resetModelCatalogsForTests } from "../../../../utils/modelCatalog";
import {
  COMPOSE_DRAFT,
  OPEN_IN_EDITOR,
  type ComposeDraft,
  type OpenInEditor,
} from "../../../../utils/events";
import type { ConfigFilesView, EntryView } from "./AgentFiles";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/home/me" }));
const invoked = vi.mocked(invoke);

const health = () => ({
  id: "claude",
  label: "Claude",
  program: "claude",
  status: "versionMatch",
  signIn: "signedIn",
  account: "a@b.c",
  apiKeySource: null,
  path: "/usr/bin/claude",
  version: "2.1.263",
  verifiedAgainst: "claude 2.1.231",
  sessionsDir: "/home/me/.claude/projects",
  sessionsDirExists: true,
  hooks: true,
  needsYou: true,
  overridePath: null,
});

const entry = (over: Partial<EntryView> = {}): EntryView => ({
  id: "instructions",
  label: "Instructions",
  kind: "file",
  path: "/home/me/.claude/CLAUDE.md",
  state: "present",
  target: null,
  children: [],
  newNameHint: null,
  ...over,
});

/** Two accounts, and between them all four states plus a dir with children:
 *  the shapes the row has to tell apart, in one fixture. */
const files = (over: Partial<ConfigFilesView> = {}): ConfigFilesView => ({
  adapterId: "claude",
  declared: true,
  profiles: [
    {
      profileId: "default",
      label: "Default",
      home: "/home/me/.claude",
      entries: [
        entry(),
        entry({
          id: "skills",
          label: "Skills",
          kind: "dir",
          path: "/home/me/.claude/skills",
          state: "symlink",
          target: "/home/me/.dotfiles/skills",
          children: ["alpha", "beta"],
          newNameHint: "skill-name",
        }),
        entry({
          id: "rules",
          label: "Rules",
          kind: "dir",
          path: "/home/me/.claude/rules",
          state: "dangling",
          target: "/home/me/gone",
          newNameHint: "rule-name",
        }),
      ],
    },
    {
      profileId: "work",
      label: "Work",
      home: "/home/me/Library/sway/claude/work",
      entries: [
        entry({ path: "/home/me/Library/sway/claude/work/CLAUDE.md", state: "missing" }),
      ],
    },
  ],
  ...over,
});

/** An accounts card that offers "Add account", for the one test that needs the
 *  set of accounts to change under the Files group. */
const accountsView = () => ({
  adapterId: "claude",
  declared: true,
  canAdd: true,
  canSignOut: true,
  profiles: [
    {
      id: "default",
      label: "Default",
      isDefault: true,
      home: null,
      signIn: "signedIn",
      account: "a@b.c",
      apiKeySource: null,
      duplicateOf: null,
      login: { type: "terminal", program: "claude", args: ["auth", "login"], home: null },
    },
  ],
});

function mount(
  over: { files?: ConfigFilesView; projectRoot?: string | null; accounts?: boolean } = {},
) {
  invoked.mockReset();
  __resetModelCatalogsForTests();
  invoked.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "agent_health" || cmd === "refresh_agent_health") return [health()];
    if (cmd === "agent_config_files") return over.files ?? files();
    if (cmd === "agent_accounts")
      return over.accounts
        ? accountsView()
        : { adapterId: "claude", declared: false, canAdd: false, canSignOut: false, profiles: [] };
    if (cmd === "add_agent_account")
      return { type: "terminal", program: "claude", args: ["auth", "login"], home: null };
    if (cmd === "model_catalogs") return [];
    if (cmd === "set_settings") return (args as { settings?: unknown })?.settings;
    return [];
  });
  return render(() => (
    <AgentsSection projectRoot={over.projectRoot === undefined ? "/work/repo" : over.projectRoot} />
  ));
}

async function open(r: ReturnType<typeof render>) {
  const card = await r.findByRole("button", { name: /Claude/ });
  fireEvent.click(card);
  await waitFor(() => expect(r.container.textContent).toContain("Files"));
  return r;
}

function opened(): OpenInEditor[] {
  const seen: OpenInEditor[] = [];
  window.addEventListener(OPEN_IN_EDITOR, (e) => seen.push((e as CustomEvent<OpenInEditor>).detail));
  return seen;
}

function drafts(): ComposeDraft[] {
  const seen: ComposeDraft[] = [];
  window.addEventListener(COMPOSE_DRAFT, (e) => seen.push((e as CustomEvent<ComposeDraft>).detail));
  return seen;
}

beforeEach(() => invoked.mockReset());

describe("the Files group", () => {
  it("lists every account's rows with what is actually at each path", async () => {
    const { container } = await open(mount());

    // Both accounts, each under its own resolved home.
    expect(container.textContent).toContain("Default");
    expect(container.textContent).toContain("/home/me/.claude");
    expect(container.textContent).toContain("Work");
    expect(container.textContent).toContain("/home/me/Library/sway/claude/work");

    // All four states, in the reader's words, and the two that point somewhere
    // say where.
    expect(container.textContent).toContain("on disk");
    expect(container.textContent).toContain("not created");
    expect(container.textContent).toContain("link -> /home/me/.dotfiles/skills");
    expect(container.textContent).toContain("broken link -> /home/me/gone");

    // A directory's children, listed through the link rather than hidden by it.
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).toContain("beta");
  });

  // Every row is resolved against one account's home, so the set of rows is a
  // function of the set of accounts. Without this the account somebody just
  // added has no files section until they reopen the page.
  it("re-resolves when an account is added above it", async () => {
    const r = await open(mount({ accounts: true }));
    await waitFor(() => expect(r.container.textContent).toContain("Accounts"));
    const before = invoked.mock.calls.filter((c) => c[0] === "agent_config_files").length;

    fireEvent.click(r.getByRole("button", { name: /Add account/ }));
    const input = await waitFor(() => screen.getByRole("textbox"));
    fireEvent.input(input, { target: { value: "Work" } });
    fireEvent.click(screen.getByText("Create and sign in"));

    await waitFor(() =>
      expect(
        invoked.mock.calls.filter((c) => c[0] === "agent_config_files").length,
      ).toBeGreaterThan(before),
    );
  });

  // "Sway has nothing true to say about this agent's files" is not the same
  // claim as "this agent has none", so it is said in words.
  it("says so plainly for an adapter that declares no files", async () => {
    const { container } = await open(
      mount({ files: { adapterId: "claude", declared: false, profiles: [] } }),
    );
    expect(container.textContent).toContain("This adapter declares no files");
  });
});

describe("opening a file from a row", () => {
  it("asks the editor for the row's own resolved path", async () => {
    const seen = opened();
    const r = await open(mount());

    fireEvent.click(await r.findByRole("button", { name: "Instructions" }));

    expect(seen).toEqual([{ path: "/home/me/.claude/CLAUDE.md" }]);
  });

  it("opens a directory's child at its full path", async () => {
    const seen = opened();
    const r = await open(mount());

    fireEvent.click(await r.findByRole("button", { name: "alpha" }));

    expect(seen).toEqual([{ path: "/home/me/.claude/skills/alpha" }]);
  });

  // Shells, and a Feature with no present member, both have a Selection and no
  // folder. A tab has to land somewhere, so the row says so instead of opening
  // one nowhere.
  it("offers no opener at all with no project selected", async () => {
    const seen = opened();
    const r = await open(mount({ projectRoot: null }));

    expect(r.queryByRole("button", { name: "Instructions" })).toBeNull();
    expect(r.container.textContent).toContain("Instructions");

    const child = await r.findByRole("button", { name: "alpha" });
    expect((child as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(child);
    expect(seen).toEqual([]);
  });
});

describe("revealing a row in Finder", () => {
  it("hands the resolved path to the backend", async () => {
    const r = await open(mount());

    const buttons = await r.findAllByRole("button", { name: "Reveal in Finder" });
    fireEvent.click(buttons[0]);

    await waitFor(() =>
      expect(invoked).toHaveBeenCalledWith("reveal_in_finder", {
        path: "/home/me/.claude/CLAUDE.md",
      }),
    );
  });

  // There is nothing to reveal until there is something at the path. Three of
  // the four rows in the fixture exist; the `missing` one does not.
  it("offers nothing to reveal on a row with no file", async () => {
    const r = await open(mount());
    const buttons = await r.findAllByRole("button", { name: "Reveal in Finder" });
    expect(buttons).toHaveLength(3);
  });
});

describe("creating a file from a row", () => {
  it("names it, creates it, and opens what came back", async () => {
    const seen = opened();
    const r = await open(mount());
    invoked.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_health" || cmd === "refresh_agent_health") return [health()];
      if (cmd === "agent_config_files") return files();
      if (cmd === "agent_config_new") return "/home/me/.claude/skills/commit/SKILL.md";
      return [];
    });

    fireEvent.click((await r.findAllByRole("button", { name: /New/ }))[0]);
    const box = await r.findByLabelText("New Skills name");
    fireEvent.input(box, { target: { value: "commit" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() =>
      expect(invoked).toHaveBeenCalledWith("agent_config_new", {
        adapterId: "claude",
        profileId: "default",
        entryId: "skills",
        name: "commit",
      }),
    );
    // Straight into the editor: the point of creating one is to write it.
    await waitFor(() =>
      expect(seen).toEqual([{ path: "/home/me/.claude/skills/commit/SKILL.md" }]),
    );
  });

  // On the row, beside the box that produced it. A toast would float away from
  // the one thing the reader has to change.
  it("shows a refused name on the row and creates nothing", async () => {
    const seen = opened();
    const r = await open(mount());
    invoked.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_health" || cmd === "refresh_agent_health") return [health()];
      if (cmd === "agent_config_files") return files();
      if (cmd === "agent_config_new") throw new Error("`a/b` cannot contain a path separator");
      return [];
    });

    fireEvent.click((await r.findAllByRole("button", { name: /New/ }))[0]);
    const box = await r.findByLabelText("New Skills name");
    fireEvent.input(box, { target: { value: "a/b" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() =>
      expect(r.container.textContent).toContain("cannot contain a path separator"),
    );
    expect(seen).toEqual([]);
  });

  it("shows a duplicate name the same way", async () => {
    const r = await open(mount());
    invoked.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_health" || cmd === "refresh_agent_health") return [health()];
      if (cmd === "agent_config_files") return files();
      if (cmd === "agent_config_new")
        throw new Error("/home/me/.claude/skills/dup/SKILL.md already exists");
      return [];
    });

    fireEvent.click((await r.findAllByRole("button", { name: /New/ }))[0]);
    const box = await r.findByLabelText("New Skills name");
    fireEvent.input(box, { target: { value: "dup" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(r.container.textContent).toContain("already exists"));
  });

  // Writing through a broken link creates the missing target instead of fixing
  // the row, so the row does not offer to. The fixture's `rules` row is the
  // dangling one, and it is the only dir row without a New.
  it("offers no create on a dangling row", async () => {
    const r = await open(mount());
    const news = await r.findAllByRole("button", { name: /New/ });
    // Instructions is present (no New), skills is a live dir, rules is
    // dangling, and Work's instructions row is missing.
    expect(news).toHaveLength(2);
  });
});

describe("handing a row to an agent", () => {
  it("emits the file plus a line naming it, and sends nothing", async () => {
    const seen = drafts();
    const r = await open(mount());

    fireEvent.click((await r.findAllByRole("button", { name: "Write it with an agent" }))[0]);

    expect(seen).toHaveLength(1);
    expect(seen[0].blocks[0]).toMatchObject({
      type: "fileRef",
      path: "/home/me/.claude/CLAUDE.md",
      label: "Instructions",
    });
    expect(seen[0].blocks[1]).toMatchObject({ type: "text" });
  });

  it("is off with no project selected", async () => {
    const seen = drafts();
    const r = await open(mount({ projectRoot: null }));

    const button = (await r.findAllByRole("button", { name: "Write it with an agent" }))[0];
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(seen).toEqual([]);
  });
});
