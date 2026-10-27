import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { PermissionList } from "./InboxView";
import type { PermissionRow } from "../../utils/permissionInbox";
import styles from "./InboxView.module.css";

function row(session: string, folder: string, extra: Partial<PermissionRow> = {}): PermissionRow {
  const r: PermissionRow = {
    session,
    id: `${session}-call`,
    project: "/work/tori",
    folder,
    agent: "claude",
    tool: "Bash",
    action: "pnpm test",
    group: "",
    autoDenyAtMs: null,
    rule: null,
    ...extra,
  };
  r.group = extra.group ?? JSON.stringify([r.project ?? r.folder, r.agent, r.tool, r.action]);
  return r;
}

const TWO_GROUPS = [
  row("s1", "/work/tori/.tori/worktrees/inbox"),
  row("s2", "/work/tori/.tori/worktrees/phone"),
  row("s3", "/work/tori/.tori/worktrees/docs"),
  row("s4", "/work/tori/.tori/worktrees/docs", { agent: "opencode", tool: "pnpm lint", action: "pnpm lint" }),
];

const meta = {
  title: "Panels/Inbox/PermissionList",
  component: PermissionList,
  args: { rows: [], onAllow: () => {}, onDeny: () => {}, onOpen: () => {} },
  decorators: [
    (Story) => (
      <div class={styles.panel} style={{ width: "640px", padding: "16px" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PermissionList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const TwoGroups: Story = { args: { rows: TWO_GROUPS } };

export const TwoProjects: Story = {
  args: {
    rows: [...TWO_GROUPS.slice(0, 2), row("s5", "/work/web", { project: "/work/web", action: "pnpm build" })],
  },
};

export const OtherBucket: Story = {
  args: {
    rows: [
      row("s6", "/Users/me/scratch", { project: null, action: "ls -la" }),
      row("s7", "/Users/me/scratch", { project: null, action: "ls -la" }),
      row("s8", "/work/tori", { agent: "codex", tool: "Edit files", action: null, group: "alone-s8" }),
    ],
  },
};

export const PersistedRule: Story = {
  args: {
    rows: [
      row("s1", "/work/tori/.tori/worktrees/inbox", { rule: "Bash(pnpm test:*)" }),
      row("s2", "/work/tori/.tori/worktrees/phone", { rule: "Bash(pnpm test:*)" }),
    ],
  },
};
