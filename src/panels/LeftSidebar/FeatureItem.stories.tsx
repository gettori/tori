import type { Meta, StoryObj } from "storybook-solidjs-vite";
import FeatureItem, { type SpaceTint } from "./FeatureItem";
import type { Feature, Member, MemberState } from "../../utils/features";

const SPACES: SpaceTint[] = [
  {
    name: "work",
    color: "Sky",
    projects: [{ path: "/w/api" }, { path: "/w/web" }, { path: "/w/infra" }],
  },
  {
    name: "side",
    color: "Emerald",
    projects: [{ path: "/s/blog" }, { path: "/s/cli" }],
  },
  { name: "Other", projects: [{ path: "/o/dotfiles" }] },
];

function member(repoPath: string, order: number, state: MemberState = { kind: "present" }): Member {
  const name = repoPath.split("/").pop() ?? repoPath;
  return {
    repoPath,
    displayName: name,
    worktreePath: state.kind === "present" ? `${repoPath}/.sway/worktrees/auth` : null,
    state,
    order,
  };
}

function feature(name: string, members: Member[]): Feature {
  return {
    id: `${name}-1`,
    name,
    branch: `feat/${name.toLowerCase().replace(/\s+/g, "-")}`,
    members,
    createdAt: 1,
  };
}

const meta = {
  title: "Panels/LeftSidebar/FeatureItem",
  component: FeatureItem,
  args: {
    spaces: SPACES,
    onRetry: () => {},
  },
  decorators: [
    (Story) => (
      <ul style={{ width: "240px", margin: 0, padding: 0 }}>
        <Story />
      </ul>
    ),
  ],
} satisfies Meta<typeof FeatureItem>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The common case: two repos from one Space, both ready. */
export const TwoMembers: Story = {
  args: {
    feature: feature("Auth flow", [member("/w/api", 0), member("/w/web", 1)]),
  },
};

/** The open Feature, with the files touched across every member on the row. The
 *  number arrives as a prop: the row itself reads no store, so it renders the
 *  same here as it does with the editor open on that Feature. */
export const OpenWithChanges: Story = {
  args: {
    feature: feature("Notifications", [member("/w/api", 0), member("/w/web", 1), member("/s/blog", 2)]),
    active: true,
    changed: 7,
  },
};

/** Nine members: six chips and a +3, the name still on one line at 240px. The
 *  width claim lives here because jsdom does no layout; the dom test only
 *  counts chips. */
export const NineMembers: Story = {
  args: {
    feature: feature("Payments migration with a name long enough to clip", [
      member("/w/api", 0),
      member("/w/web", 1),
      member("/w/infra", 2),
      member("/s/blog", 3),
      member("/s/cli", 4),
      member("/o/dotfiles", 5),
      member("/w/api-2", 6),
      member("/w/web-2", 7),
      member("/w/infra-2", 8),
    ]),
  },
};

/** One member failed with git's reason in the badge tooltip and a Retry under
 *  the chips; one still creating. */
export const OneFailed: Story = {
  args: {
    feature: feature("Search", [
      member("/w/api", 0),
      member("/w/web", 1, {
        kind: "failed",
        reason: "fatal: 'feat/search' is already checked out at '/w/web'",
      }),
      member("/s/cli", 2, { kind: "failed", reason: "pending" }),
    ]),
  },
};

/** A member whose repo sits in no Space renders the neutral chip. */
export const OutsideEverySpace: Story = {
  args: {
    feature: feature("Hotfix", [
      member("/w/api", 0),
      member("/tmp/scratch", 1),
      member("/s/blog", 2, { kind: "worktree-missing" }),
    ]),
  },
};
