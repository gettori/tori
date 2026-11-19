import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { mockIPC } from "@tauri-apps/api/mocks";
import Omnibox from "./Omnibox";
import type { Selection } from "../../panels/LeftSidebar/LeftSidebar";
import { clearEditorState, publishEditorState } from "../../utils/editorState";
import { clearSymbols, normalizeDocumentSymbols, publishSymbols } from "../../utils/symbols";
import { note, saveFrecency } from "../../utils/frecency";
import { noteNavTree, type OverviewSession } from "../../utils/navIndex";
import { applyTopic } from "../../utils/topicStore";
import { ensureChatsRoot } from "../../utils/chats";
import { noteDots, noteLiveTabs } from "../../utils/sessionActivity";
import { noteForgeEnabled, noteWatchedProjects, pollNow, refreshForgeAccounts } from "../../utils/forgeStatus";
import type { UnitStatus } from "../../utils/forgeTypes";

// The command palette, one story per mode, since a mode is the whole shape of
// what is on screen rather than a variant of it.
//
// The workshop has no Tauri host behind it, so `list_project_files` answers
// nothing and the box shows what it can reach without a backend: the jump list
// and the frecency store (both browser storage), the command registry (a static
// table) and the mode list. That is enough to judge every row shape it renders,
// which is what these are for.

const REPO = "/Users/you/Projects/tori";

const selection: Selection = {
  spaceName: "personal",
  projectName: "tori",
  projectPath: REPO,
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
  profile: null,
};

const SYMBOLS = normalizeDocumentSymbols(
  [
    {
      name: "Omnibox",
      kind: 12,
      range: { start: { line: 159, character: 0 }, end: { line: 704, character: 1 } },
      selectionRange: { start: { line: 159, character: 24 }, end: { line: 159, character: 31 } },
      children: [
        {
          name: "fileRows",
          kind: 6,
          range: { start: { line: 326, character: 2 }, end: { line: 360, character: 3 } },
          selectionRange: { start: { line: 326, character: 8 }, end: { line: 326, character: 16 } },
        },
      ],
    },
    {
      name: "unmetReason",
      kind: 12,
      range: { start: { line: 92, character: 0 }, end: { line: 109, character: 1 } },
      selectionRange: { start: { line: 92, character: 9 }, end: { line: 92, character: 20 } },
    },
  ],
  `${REPO}/src/components/Omnibox/Omnibox.tsx`,
);

/** Every story starts from the same known state rather than from whatever the
 *  one before it left in module scope and browser storage. */
function seed(options: { file?: boolean; recents?: boolean; symbols?: boolean } = {}) {
  clearSymbols();
  clearEditorState();
  localStorage.clear();

  if (options.recents) {
    const now = Date.now();
    let store = {};
    for (const [i, rel] of ["src/App.tsx", "src/utils/fuzzy.ts", "src/theme/roles.ts"].entries()) {
      store = note(store, REPO, `${REPO}/${rel}`, "edit", now - (3 - i) * 60_000);
    }
    saveFrecency(store);
  }

  const active = `${REPO}/src/components/Omnibox/Omnibox.tsx`;
  if (options.file || options.symbols) {
    publishEditorState({
      activePath: active,
      dirty: true,
      tabCount: 3,
      projectRoot: REPO,
      recentJumps: options.recents
        ? [{ path: `${REPO}/src/components/Dialog/Dialog.tsx`, line: 37 }, { path: `${REPO}/src/lib/combobox.ts` }]
        : [],
    });
  }
  if (options.symbols) publishSymbols(active, SYMBOLS);
}

const WEB = "/Users/you/Projects/tori-web";
const SEARCH = `${REPO}-wt/sidebar-search`;
const SIDE = `${REPO}-wt/fix-side-effects`;
const CHATS = "/Users/you/.config/tori/chats";

const PULLS: Record<string, [number, string, Partial<UnitStatus>]> = {
  "sidebar-search": [212, "Search the sidebar", { reviewDecision: "approved" }],
  "fix-side-effects": [207, "Stop the save hook firing twice", { reviewDecision: "changesRequested" }],
};

const OVERVIEW: OverviewSession[] = [
  {
    id: "s-order",
    title: "Keep the sidebar order across restarts",
    name: null,
    agent: "claude",
    profile_label: null,
    last_active: 3,
    home: { project: REPO, folder: SEARCH, branch: "sidebar-search" },
  },
  {
    id: "s-hook",
    title: "t",
    name: "Side effects in the save hook",
    agent: "claude",
    profile_label: null,
    last_active: 2,
    home: { project: REPO, folder: SIDE, branch: "fix-side-effects" },
  },
];

function status(branch: string): UnitStatus {
  const [number, title, over] = PULLS[branch];
  return {
    headRef: branch,
    pullRequest: {
      number,
      title,
      body: null,
      state: "open",
      isDraft: false,
      author: "you",
      createdAt: "2026-11-18T10:00:00Z",
      mergedAt: null,
      closedAt: null,
      comments: 0,
      headRef: branch,
      baseRef: "main",
      headSha: "sha",
      headRepoIsOrigin: true,
      url: `https://example.test/pull/${number}`,
      mergeableState: "clean",
      stack: null,
    },
    checks: { state: "none", total: 0, failing: 0, skipped: 0, contexts: [] },
    reviewDecision: "none",
    reviews: [],
    requestedReviewers: [],
    viewerReview: null,
    ...over,
  };
}

function seedPlaces() {
  mockIPC(
    (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      if (cmd === "sessions_overview") return OVERVIEW;
      if (cmd === "chats_root") return CHATS;
      if (cmd === "list_sessions" && a.folder === CHATS)
        return [{ ...OVERVIEW[0], id: "c-1", cwd: `${CHATS}/.home/c-1`, name: "Sidecar ideas", path: "", branch: "" }];
      if (cmd === "forge_accounts")
        return [
          {
            host: "github.com",
            accounts: [
              {
                id: "me",
                provider: "github",
                baseUrl: "https://github.com",
                login: "you",
                label: "you",
                expiresAt: null,
                auth: { kind: "signedIn", login: "you" },
              },
            ],
          },
        ];
      if (cmd === "forge_repo_account") return { kind: "account", accountId: "me", host: "github.com" };
      if (cmd === "forge_unit_statuses")
        return {
          statuses: Object.keys(PULLS).map(status),
          uncovered: 0,
          rate: { remaining: null, limit: null, resetAt: null },
        };
      return null;
    },
    { shouldMockEvents: true },
  );
  const unit = (folderPath: string, branch: string, kind = "worktree") => ({ folderPath, branch, label: branch, kind });
  noteNavTree(
    [
      {
        name: "Work",
        icon: "Briefcase",
        projects: [
          {
            name: "tori",
            path: REPO,
            branchUnits: [
              unit(`${REPO}-wt/main`, "main"),
              {
                ...unit(SEARCH, "sidebar-search"),
                issue: { key: "47", display: "#47", url: "https://example.test/47", title: "Search the sidebar" },
              },
              unit(SIDE, "fix-side-effects"),
            ],
          },
          { name: "tori-web", path: WEB, branchUnits: [unit(WEB, "main", "plain")] },
        ],
      },
      { name: "/global", projects: [] },
    ],
    { [REPO]: "git@github.com:you/tori.git", [WEB]: "https://github.com/you/tori-web.git" },
  );
  applyTopic({
    id: "t-1",
    name: "Sidebar rework",
    branch: "sidebar-rework",
    createdAt: 0,
    space: "Work",
    members: [
      {
        repoPath: REPO,
        displayName: "tori",
        mode: "worktree",
        worktreePath: null,
        state: { kind: "present" },
        order: 0,
      },
      {
        repoPath: WEB,
        displayName: "tori-web",
        mode: "reference",
        worktreePath: null,
        state: { kind: "present" },
        order: 1,
      },
    ],
  });
  void ensureChatsRoot();
  noteLiveTabs([{ id: "tab-1", workspace: SEARCH, kind: "agent", sessionId: "s-order", state: "live" }]);
  noteDots([{ id: "s-order", dot: "needsYou", certainty: "exact", home: OVERVIEW[0].home }]);
  noteForgeEnabled(true);
  noteWatchedProjects([{ path: REPO, units: Object.keys(PULLS).map((branch) => ({ branch, visible: true })) }]);
  void refreshForgeAccounts().then(() => pollNow("manual"));
}

const meta = {
  title: "Components/Omnibox",
  component: Omnibox,
  parameters: { layout: "fullscreen" },
  args: {
    home: "file",
    selected: selection,
    onOpenSettings: () => {},
    onClose: () => {},
  },
} satisfies Meta<typeof Omnibox>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The empty box, which is the one the grouping is for: where you have just
 *  been, then the files you work in, then the rest of the project under its own
 *  heading. Three blocks, so it is also the case that proves more than one
 *  heading survives a re-render. */
export const Files: Story = {
  render: (args) => {
    seed({ file: true, recents: true });
    return <Omnibox {...args} prefix="" />;
  },
};

/** Cmd+K's home, with no filter typed: the tag names it and the lead glyph
 *  stays muted. */
export const Everything: Story = {
  args: { home: "all" },
  render: (args) => {
    seed();
    return <Omnibox {...args} prefix="" />;
  },
};

/** "side" typed from Cmd+K: places and commands in one ranked list, each
 *  place with where it sits, its ticket and pull request, and a dot for the
 *  session waiting on you. */
export const Side: Story = {
  args: { home: "all", prefix: "side" },
  render: (args) => {
    seed();
    seedPlaces();
    return <Omnibox {...args} />;
  },
};

/** The registry, with the two row shapes only this mode has: key chips for a
 *  command that also carries a binding, and a refusal reason for one whose
 *  requirement is unmet. Nothing is open here, so several are refused. */
export const Commands: Story = {
  render: (args) => {
    seed();
    return <Omnibox {...args} prefix=">" />;
  },
};

/** `?`, the mode whose results are the modes. Every row is a signpost: picking
 *  one retypes the box and leaves it open. */
export const Prefixes: Story = {
  render: (args) => {
    seed();
    return <Omnibox {...args} prefix="?" />;
  },
};

/** `@`, the open file's symbols in document order, each with its kind glyph. */
export const Symbols: Story = {
  render: (args) => {
    seed({ symbols: true, file: true });
    return <Omnibox {...args} prefix="@" />;
  },
};

/** Nothing to show, which every mode words for itself. With no file open there
 *  is nothing to go to a line in, and the list is withdrawn rather than
 *  emptied. */
export const Empty: Story = {
  render: (args) => {
    seed();
    return <Omnibox {...args} prefix=":" />;
  },
};
