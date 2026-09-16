import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import Switch from "./Switch";

const meta = {
  title: "Components/Switch",
  component: Switch,
  args: {
    label: "Stream responses",
    checked: false,
    onChange: () => {},
  },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default: a setting whose flip *is* the action. Nothing to confirm, so
 *  the control reads as a state rather than as a choice being collected. */
export const Default: Story = {
  render: (args) => {
    const [checked, setChecked] = createSignal(false);
    return <Switch {...args} checked={checked()} onChange={setChecked} />;
  },
};

/** Both states side by side. The off track is the neutral surface and the on
 *  track is the accent, so this is the story that says whether the two are
 *  still distinguishable in light and dark. */
export const States: Story = {
  render: (args) => (
    <div style={{ display: "flex", "flex-direction": "column", gap: "var(--tori-space-3)" }}>
      <Switch {...args} checked={false} label="Off" />
      <Switch {...args} checked label="On" />
      <Switch {...args} checked={false} label="Disabled" disabled />
      <Switch {...args} checked label="Disabled and on" disabled />
    </div>
  ),
};

/** A settings pane's worth of rows, the shape the Settings panes use. */
export const SettingsRows: Story = {
  render: () => {
    const [streaming, setStreaming] = createSignal(true);
    const [blame, setBlame] = createSignal(false);
    const [diffs, setDiffs] = createSignal(true);
    return (
      <div style={{ display: "flex", "flex-direction": "column", gap: "var(--tori-space-3)" }}>
        <Switch checked={streaming()} onChange={setStreaming} label="Stream responses" />
        <Switch checked={blame()} onChange={setBlame} label="Git blame" />
        <Switch checked={diffs()} onChange={setDiffs} label="Side-by-side diffs" />
      </div>
    );
  },
};
