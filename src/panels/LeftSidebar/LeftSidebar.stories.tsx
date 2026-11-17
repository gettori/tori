import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { stubHost } from "../../dev/stubHost";
import { SidebarPane, sidebarHost } from "./__fixtures__/sidebar";

function Sidebar(props: { space: string }) {
  stubHost([sidebarHost]);
  return <SidebarPane space={props.space} />;
}

const meta = {
  title: "Sidebar/Kitchen sink",
  component: Sidebar,
  args: { space: "/global" },
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Home with 25 chats, 11 Topics and 10 attached folders: every group past
 *  its cap, two busy chats kept past it. */
export const Home: Story = {};

/** A named space with 8 chats, 9 Topics and 14 projects, one of them with ten
 *  branches. */
export const Space: Story = { args: { space: "work" } };
