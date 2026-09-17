import type { Meta, StoryObj } from "storybook-solidjs-vite";
import ProblemsPanel from "./ProblemsPanel";
import { clearDiagnostics, publishDiagnostics, type Problem } from "../../utils/diagnostics";
import { spaceHue } from "../../utils/spaceTint";
import type { MemberRoot } from "../../utils/topicMembers";
import type { Selection } from "../LeftSidebar/LeftSidebar";

const API = "/feat/api";
const WEB = "/feat/web";

const p = (line: number, severity: Problem["severity"], message: string): Problem => ({
  line,
  endLine: line,
  column: 5,
  severity,
  message,
});

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

/** Fill the store the panel reads. The editor publishes here on every lint
 *  change; a story has to do it by hand. */
function loadDiagnostics() {
  clearDiagnostics();
  publishDiagnostics(`${API}/src/routes/notifications.rs`, [
    p(42, "error", "cannot borrow `state` as mutable more than once"),
    p(51, "warning", "unused variable: `tx`"),
  ]);
  publishDiagnostics(`${API}/src/services/notification.rs`, [p(8, "hint", "consider using `if let`")]);
  publishDiagnostics(`${WEB}/src/components/Notification.tsx`, [
    p(17, "error", "Property 'onDismiss' is missing in type 'Props'"),
  ]);
}

const selection = (folderPath: string) => ({ folderPath }) as unknown as Selection;

const meta = {
  title: "Editor/ProblemsPanel",
  component: ProblemsPanel,
  args: { selected: selection(API) },
  decorators: [
    (Story) => (
      <div style={{ display: "flex", width: "380px", height: "480px" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProblemsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One repo, no headers: a branch unit's Problems list is what it always was. */
export const BranchUnit: Story = {
  render: (args) => {
    loadDiagnostics();
    return <ProblemsPanel {...args} />;
  },
};

/** Two members at once, each with its own section. The active member is the API,
 *  yet the Web App's error is still on screen: a Topic's problems are the
 *  Topic's, not the repo you happen to be looking at. */
export const TopicMembers: Story = {
  args: { roots: MEMBERS },
  render: (args) => {
    loadDiagnostics();
    return <ProblemsPanel {...args} />;
  },
};

/** A member whose worktree is gone keeps its header. The badge is the only place
 *  that says why there is nothing under it. */
export const BrokenMember: Story = {
  args: {
    roots: [
      MEMBERS[0],
      {
        ...MEMBERS[1],
        path: "/repos/web",
        state: { label: "Worktree missing", usable: false, action: "recreate", reason: null },
      },
    ],
  },
  render: (args) => {
    loadDiagnostics();
    return <ProblemsPanel {...args} />;
  },
};
