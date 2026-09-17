import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { mockIPC } from "@tauri-apps/api/mocks";
import ReviewPanel from "./ReviewPanel";
import { memberState } from "../../utils/topics";
import { enterRoots, refreshGit } from "../../utils/gitActions";
import { spaceHue } from "../../utils/spaceTint";
import type { MemberRoot } from "../../utils/topicMembers";

const API = "/feat/api";
const WEB = "/feat/web";
const DOCS = "/feat/docs";

const file = (status: string, path: string, staged: boolean, unstaged: boolean) => ({
  status,
  path,
  staged,
  unstaged,
  conflicted: false,
});

/** What each member's `git status` reports. One member mid-conflict, one with a
 *  normal staged/unstaged split, one clean: the three states a section header
 *  has to read differently. */
const STATUS: Record<string, ReturnType<typeof file>[]> = {
  [API]: [
    file("M ", "src/routes/notifications.rs", true, false),
    file("M ", "src/services/notification.rs", true, false),
    file(" M", "Cargo.toml", false, true),
    file("??", "src/routes/scratch.rs", false, true),
  ],
  [WEB]: [
    { ...file("UU", "src/components/Notification.tsx", false, false), conflicted: true },
    { ...file("UU", "src/hooks/useNotifications.ts", false, false), conflicted: true },
    file(" M", "package.json", false, true),
  ],
  [DOCS]: [],
};

const AHEAD: Record<string, { ahead: number; behind: number; has_upstream: boolean }> = {
  [API]: { ahead: 3, behind: 0, has_upstream: true },
  [WEB]: { ahead: 0, behind: 0, has_upstream: false },
  [DOCS]: { ahead: 0, behind: 0, has_upstream: true },
};

/** The workshop runs in a plain browser, so every command the panel sends has to
 *  be answered here or it paints empty. Answers are keyed by the root each call
 *  names, which is the whole point of a slot per member. */
function stubHost() {
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const root = (a.projectPath ?? a.path ?? a.repo) as string;
    switch (cmd) {
      case "git_status":
        return STATUS[root] ?? [];
      case "list_branches":
        return [{ name: "feat/notifications", current: true }];
      case "git_ahead_behind":
        return AHEAD[root] ?? null;
      case "git_head_sha":
        return "abc1234";
      case "git_stash_list":
        return [];
      case "git_origin":
        return "git@github.com:acme/api.git";
      case "git_default_base_branch":
        return "main";
      case "forge_repo_account":
        return { kind: "noAccount", host: "github.com" };
      case "git_diff_text":
        return [
          `diff --git a/${a.file} b/${a.file}`,
          `--- a/${a.file}`,
          `+++ b/${a.file}`,
          "@@ -1,3 +1,3 @@",
          " one",
          "-two",
          "+TWO",
          " three",
          "",
        ].join("\n");
      default:
        return null;
    }
  });
}

// The tints come from the same helper the sidebar's chips use, so a chip here is
// the chip a member's Space would actually paint.
const MEMBERS: MemberRoot[] = [
  { path: API, repoPath: "/repos/api", label: "Payments API", tint: spaceHue("backend", "Indigo") },
  { path: WEB, repoPath: "/repos/web", label: "Web App", tint: spaceHue("frontend", "Emerald") },
  { path: DOCS, repoPath: "/repos/docs", label: "Docs Site", tint: spaceHue("docs", "Amber") },
];

/** Fill the store the panel reads. Entering is the app's own move (Editor does
 *  it on every selection change), and a refresh fills a slot but never opens
 *  one, so a story that only refreshed would paint nothing. */
function loadRoots(roots: MemberRoot[], active: string) {
  const paths = roots.filter((m) => m.state?.usable !== false).map((m) => m.path);
  enterRoots(paths, active);
  for (const p of paths) void refreshGit(p);
}

const meta = {
  title: "Editor/ReviewPanel",
  component: ReviewPanel,
  args: {
    root: API,
    selected: null,
  },
  decorators: [
    (Story) => {
      stubHost();
      return (
        <div style={{ display: "flex", width: "380px", height: "620px" }}>
          <Story />
        </div>
      );
    },
  ],
} satisfies Meta<typeof ReviewPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Three members at once. Each header carries its own chip, branch, ahead/behind
 *  and Push, and each section stages, commits and discards in its own repo: the
 *  Web App member is mid-conflict, the API member has a normal staged/unstaged
 *  split, and the Docs member is clean but keeps its header, because that is
 *  where its branch and its Push live.
 *
 *  Branch, ahead/behind and Push are absent from the top bar here. They are one
 *  repo's answers, and a Topic has several. */
export const TopicMembers: Story = {
  args: { roots: MEMBERS },
  render: (args) => {
    loadRoots(MEMBERS, API);
    return <ReviewPanel {...args} />;
  },
};

/** A member with no worktree keeps its header and says why it has no file list,
 *  with the repair beside it, rather than looking like a repo with no changes. */
export const MemberMissing: Story = {
  args: {
    roots: [MEMBERS[0], MEMBERS[1], { ...MEMBERS[2], state: memberState({ kind: "worktree-missing" }) }],
  },
  render: (args) => {
    loadRoots(args.roots ?? [], API);
    return <ReviewPanel {...args} />;
  },
};

/** One root renders headerless, exactly as a branch unit always has: branch and
 *  Push back in the top bar, one set of sections, no chip. */
export const SingleRoot: Story = {
  render: (args) => {
    loadRoots([MEMBERS[0]], API);
    return <ReviewPanel {...args} />;
  },
};
