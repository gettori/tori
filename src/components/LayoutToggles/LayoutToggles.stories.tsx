import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal, onCleanup } from "solid-js";
import LayoutToggles from "./LayoutToggles";
import { on, TOGGLE_SIDEBAR, TOGGLE_TERMINAL, TOGGLE_EDITOR } from "../../utils/events";

const meta = {
  title: "Components/LayoutToggles",
  component: LayoutToggles,
  args: {
    showSidebar: true,
    showTerminal: true,
    showEditor: true,
  },
} satisfies Meta<typeof LayoutToggles>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The component emits app events rather than calling back, so a story has to
 *  close the loop itself to be interactive. This is the topbar's wiring in
 *  miniature. */
function Live(props: { showSidebar: boolean; showTerminal: boolean; showEditor: boolean }) {
  const [sidebar, setSidebar] = createSignal(props.showSidebar);
  const [terminal, setTerminal] = createSignal(props.showTerminal);
  const [editor, setEditor] = createSignal(props.showEditor);

  const offs = [
    on(TOGGLE_SIDEBAR, () => setSidebar((v) => !v)),
    on(TOGGLE_TERMINAL, () => setTerminal((v) => !v)),
    on(TOGGLE_EDITOR, () => setEditor((v) => !v)),
  ];
  onCleanup(() => offs.forEach((off) => off()));

  return (
    <LayoutToggles showSidebar={sidebar()} showTerminal={terminal()} showEditor={editor()} />
  );
}

/** All three panes showing: the plain icon-button look. Arrow keys rove across
 *  the cluster (one toggle group, `multiple` mode), and each press toggles only
 *  its own pane. */
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

/** The ">=1 visible" invariant: with the editor hidden, the terminal is the
 *  last pane showing and is disabled, and its tooltip says why. A disabled
 *  button fires no pointer events, so that tooltip only works because `Tooltip`
 *  wraps the control in a hover surface, through the toggle item. */
export const TerminalIsLastVisible: Story = {
  args: { showEditor: false },
  render: (args) => <Live {...args} />,
};
