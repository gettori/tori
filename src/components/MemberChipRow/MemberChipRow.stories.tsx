import type { Meta, StoryObj } from "storybook-solidjs-vite";
import MemberChipRow from "./MemberChipRow";
import { spaceHue, spaceHueRgb } from "../../utils/spaceTint";
import type { TintedMember } from "../../utils/featureMembers";

/** The right panel's narrowest width (`RIGHT_W_MIN` in Editor.tsx). The row has
 *  to stay readable here, which is what the cap is for. */
const PANEL_MIN = 160;

const COLORS = ["Indigo", "Emerald", "Amber", "Rose", "Sky", "Violet", "Lime", "Cyan"];

const member = (name: string, i: number, broken = false): TintedMember => {
  const color = COLORS[i % COLORS.length];
  const hue = spaceHue(name, color);
  return {
    member: {
      repoPath: `/repos/${name}`,
      displayName: name,
      worktreePath: broken ? null : `/feat/${name}`,
      state: broken ? { kind: "worktree-missing" } : { kind: "present" },
      order: i,
    } as TintedMember["member"],
    key: broken ? `/repos/${name}` : `/feat/${name}`,
    label: name,
    state: broken
      ? { label: "Worktree missing", usable: false, action: "recreate", reason: null }
      : { label: "Ready", usable: true, action: null, reason: null },
    hue,
    style: { "--chip-hue": hue, "--chip-rgb": spaceHueRgb(name, color) },
    spaceName: "work",
    projectName: name,
    kind: "worktree",
  };
};

const THREE = ["api", "web", "docs"].map((n, i) => member(n, i));
const EIGHT = ["api", "web", "docs", "infra", "mobile", "cli", "sdk", "analytics"].map((n, i) =>
  member(n, i),
);

const meta = {
  title: "Components/MemberChipRow",
  component: MemberChipRow,
  args: { members: THREE, activeRoot: "/feat/web", onActiveRoot: () => {} },
  decorators: [
    (Story) => (
      <div style={{ width: `${PANEL_MIN}px`, border: "1px solid var(--border-default)" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MemberChipRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Three members, all visible, the active one filled in. */
export const UnderTheCap: Story = {};

/** Eight members at the panel's 160px minimum. Six chips, then `+2`. */
export const OverTheCap: Story = {
  args: { members: EIGHT, activeRoot: "/feat/api" },
};

/** The eighth member is the active one. It takes the last visible slot instead
 *  of hiding behind `+N`: a row that cannot show which member the pane is about
 *  has no reason to exist. */
export const ActiveMemberPastTheCap: Story = {
  args: { members: EIGHT, activeRoot: "/feat/analytics" },
};

/** A member with nothing on disk. It keeps its place and wears its state, and
 *  clicking it does nothing: there is no folder to point the panes at. */
export const BrokenMember: Story = {
  args: {
    members: [member("api", 0), member("web", 1, true), member("docs", 2)],
    activeRoot: "/feat/api",
  },
};
