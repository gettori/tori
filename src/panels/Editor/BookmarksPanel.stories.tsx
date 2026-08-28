import type { Meta, StoryObj } from "storybook-solidjs-vite";
import BookmarksPanel, { type BookmarkRow } from "./BookmarksPanel";
import { spaceHue } from "../../utils/spaceTint";
import type { MemberRoot } from "../../utils/featureMembers";

const API = "/feat/api";
const WEB = "/feat/web";

// The tints come from the same helper the sidebar's chips use, so a chip here is
// the chip a member's Space would actually paint.
const MEMBERS: MemberRoot[] = [
  {
    path: API,
    repoPath: "/repos/api",
    label: "Payments API",
    tint: spaceHue("backend", "Indigo"),
    state: { label: "Ready", usable: true, action: null, reason: null },
  },
  {
    path: WEB,
    repoPath: "/repos/web",
    label: "Web App",
    tint: spaceHue("frontend", "Emerald"),
    state: { label: "Ready", usable: true, action: null, reason: null },
  },
];

const UNIT_ROWS: BookmarkRow[] = [
  { path: `${API}/src/routes/notifications.rs`, line: 42 },
  { path: `${API}/src/services/notification.rs`, line: 8, label: "the retry" },
  { path: `${API}/Cargo.toml`, line: 3 },
];

const FEATURE_ROWS: BookmarkRow[] = [
  ...UNIT_ROWS,
  { path: `${WEB}/src/components/Notification.tsx`, line: 17 },
  { path: `${WEB}/src/hooks/useNotifications.ts`, line: 91, label: "where it polls" },
];

const meta = {
  title: "Editor/BookmarksPanel",
  component: BookmarksPanel,
  args: {
    rows: UNIT_ROWS,
    root: API,
    onLabel: () => {},
    onRemove: () => {},
  },
  decorators: [
    (Story) => (
      <div style={{ display: "flex", width: "380px", height: "420px" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BookmarksPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One repo, no headers, every folder relative to the one root. */
export const BranchUnit: Story = {};

/** Two members. Each row's second line is relative to its own member, so the
 *  part that differs is the part you read: relativising the Web App's rows
 *  against the active API member would print two absolute paths instead. */
export const FeatureMembers: Story = {
  args: { rows: FEATURE_ROWS, roots: MEMBERS },
};

/** A mark left behind by a repository that was removed from the Feature. Its
 *  worktree is kept by default, so the file is still there and the mark still
 *  opens it: it collects at the bottom rather than disappearing. */
export const OutsideTheFeature: Story = {
  args: {
    rows: [...FEATURE_ROWS, { path: "/feat/analytics/src/track.ts", line: 5 }],
    roots: MEMBERS,
  },
};
