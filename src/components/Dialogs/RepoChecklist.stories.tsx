import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import RepoChecklist from "./RepoChecklist";

const SPACES = [
  {
    name: "work",
    external: false,
    projects: [
      { name: "api", path: "/w/api" },
      { name: "web", path: "/w/web" },
    ],
  },
  {
    name: "infra",
    external: false,
    projects: [{ name: "terraform", path: "/i/terraform" }],
  },
  {
    name: "pinned",
    external: true,
    projects: [{ name: "dotfiles", path: "/p/dotfiles" }],
  },
];

const meta = {
  title: "Dialogs/RepoChecklist",
  component: RepoChecklist,
  args: { spaces: SPACES, value: [], onChange: () => {} },
} satisfies Meta<typeof RepoChecklist>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Three Spaces in rail order: the two root ones, then the pinned one. */
export const ThreeSpaces: Story = {
  render: (args) => {
    const [value, setValue] = createSignal<string[]>([]);
    return <RepoChecklist {...args} value={value()} onChange={setValue} />;
  },
};

/** A repo that is already a member is not offered; a Space left with nothing
 *  to offer is not shown at all. */
export const WithExclusions: Story = {
  render: (args) => {
    const [value, setValue] = createSignal<string[]>([]);
    return <RepoChecklist {...args} value={value()} onChange={setValue} exclude={["/w/api", "/i/terraform"]} />;
  },
};

/** The collision slot, as the creation dialog fills it. */
export const WithCollision: Story = {
  render: (args) => {
    const [value, setValue] = createSignal<string[]>(["/w/api"]);
    return (
      <RepoChecklist
        {...args}
        value={value()}
        onChange={setValue}
        collision={(path) => (path === "/w/api" ? <span>feat/auth already exists</span> : undefined)}
      />
    );
  },
};
