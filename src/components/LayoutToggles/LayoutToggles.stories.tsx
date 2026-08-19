import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal, onCleanup } from "solid-js";
import LayoutToggles from "./LayoutToggles";
import { on, TOGGLE_SIDEBAR } from "../../utils/events";

const meta = {
  title: "Components/LayoutToggles",
  component: LayoutToggles,
  args: { showSidebar: true },
} satisfies Meta<typeof LayoutToggles>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The component emits app events rather than calling back, so a story has to
 *  close the loop itself to be interactive. This is the topbar's wiring in
 *  miniature. */
function Live(props: { showSidebar: boolean }) {
  const [sidebar, setSidebar] = createSignal(props.showSidebar);
  const off = on(TOGGLE_SIDEBAR, () => setSidebar((v) => !v));
  onCleanup(off);
  return <LayoutToggles showSidebar={sidebar()} />;
}

/** The sidebar showing: the plain icon-button look. */
export const Default: Story = {
  render: (args) => <Live {...args} />,
};

/** A hidden pane accents its glyph as a "click to bring it back" cue. The rule
 *  hangs off Kobalte's `data-pressed` rather than a class passed in, which is
 *  what keeps it from being clobbered by IconButton's own `classList`. */
export const SidebarHidden: Story = {
  args: { showSidebar: false },
  render: (args) => <Live {...args} />,
};
