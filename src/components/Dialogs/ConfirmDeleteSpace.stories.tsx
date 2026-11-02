import type { Meta, StoryObj } from "storybook-solidjs-vite";
import ConfirmDeleteSpace, { type DeleteEntry } from "./ConfirmDeleteSpace";
import type { Member, Topic } from "../../utils/topics";

// The type-the-name gate is the point, and it cannot be seen from a screenshot:
// open any story and the Delete button stays disabled until the space name is
// typed exactly, which is what the whole blast-radius list above it is arguing
// for.
const ENTRIES: DeleteEntry[] = [
  { name: "api", kind: "repo", dirty: true, unpushed: false },
  { name: "web", kind: "repo", dirty: false, unpushed: true },
  { name: "notes", kind: "folder", dirty: false, unpushed: false },
  { name: "TODO.md", kind: "file", dirty: false, unpushed: false },
];

const meta = {
  title: "Dialogs/ConfirmDeleteSpace",
  component: ConfirmDeleteSpace,
  argTypes: {
    spaceName: { control: "text" },
    loading: { control: "boolean" },
    runningCount: { control: "number" },
    sizeBytes: { control: "number" },
    title: { control: "text" },
    confirmLabel: { control: "text" },
  },
  args: {
    spaceName: "work",
    kind: "space",
    path: "~/code/work",
    entries: ENTRIES,
    loading: false,
    runningCount: 0,
    sizeBytes: 48 * 1024 * 1024,
    onConfirm: () => {},
    onCancel: () => {},
  },
} satisfies Meta<typeof ConfirmDeleteSpace>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Type `work` into the field to arm the Delete button. */
export const Playground: Story = {};

/** Everything still arriving: repo flags unknown, size not counted yet. */
export const StillCounting: Story = {
  args: { loading: true, sizeBytes: null },
};

/** Nothing below it. The list says so rather than rendering an empty box. */
export const EmptySpace: Story = {
  args: { entries: [], sizeBytes: 0 },
};

/** Agents are running under this space, and deleting it stops them. */
export const AgentsRunning: Story = {
  args: { runningCount: 3 },
};

/** The same dialog serving a plain folder, which is what the copy overrides are
 *  for. */
export const PlainFolder: Story = {
  args: {
    spaceName: "scratch",
    kind: "folder",
    path: "~/code/work/scratch",
    title: "Delete folder “scratch”?",
    confirmLabel: "Delete folder",
    entries: [{ name: "old.log", kind: "file", dirty: false, unpushed: false }],
  },
};

const SPACES = [
  {
    name: "work",
    projects: [
      { name: "api", path: "/w/api" },
      { name: "web", path: "/w/web" },
    ],
  },
  { name: "side", projects: [{ name: "lab", path: "/s/lab" }] },
];
const member = (repoPath: string, order: number): Member => ({
  repoPath,
  displayName: repoPath.split("/").pop()!,
  mode: "reference",
  worktreePath: null,
  state: { kind: "present" },
  order,
});
const topic = (name: string, members: Member[], space?: string): Topic => ({
  id: name,
  name,
  branch: `feat/${name}`,
  members,
  createdAt: 0,
  ...(space ? { space } : {}),
});

/** A space with Topics of its own, and global Topics that reach into it: one
 *  keeps a member elsewhere, one is left empty. */
export const WithTopics: Story = {
  args: {
    spaces: SPACES,
    topics: [
      topic("Checkout", [member("/w/api", 0), member("/w/web", 1)], "work"),
      topic("Launch", [member("/s/lab", 0), member("/w/web", 1), member("/w/api", 2)]),
      topic("Docs", [member("/w/web", 0)]),
    ],
  },
};
