import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import Checkbox from "./Checkbox";

const meta = {
  title: "Components/Checkbox",
  component: Checkbox,
  args: {
    label: "Include untracked files",
    checked: false,
    onChange: () => {},
  },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default: an option that scopes an action the user has not confirmed yet.
 *  Controlled, so the box shows whatever the caller's state says rather than
 *  whatever was last clicked. */
export const Default: Story = {
  render: (args) => {
    const [checked, setChecked] = createSignal(false);
    return <Checkbox {...args} checked={checked()} onChange={setChecked} />;
  },
};

/** Both states side by side, which is what the theme toolbar is for: the
 *  unchecked box reads against the input surface, the checked one against the
 *  accent, and both have to hold in light and dark. */
export const States: Story = {
  render: (args) => (
    <div style={{ display: "flex", "flex-direction": "column", gap: "var(--tori-space-3)" }}>
      <Checkbox {...args} checked={false} label="Unchecked" />
      <Checkbox {...args} checked label="Checked" />
      <Checkbox {...args} checked={false} label="Disabled" disabled />
      <Checkbox {...args} checked label="Disabled and checked" disabled />
    </div>
  ),
};

/** A group, the shape the dialogs use: several independent options stacked
 *  under one action. */
export const Group: Story = {
  render: () => {
    const [local, setLocal] = createSignal(true);
    const [remote, setRemote] = createSignal(false);
    return (
      <div style={{ display: "flex", "flex-direction": "column", gap: "var(--tori-space-3)" }}>
        <Checkbox
          checked={local()}
          onChange={setLocal}
          label="Delete local branch (git branch -D)"
        />
        <Checkbox
          checked={remote()}
          onChange={setRemote}
          label="Delete remote branch (git push --delete)"
        />
      </div>
    );
  },
};
