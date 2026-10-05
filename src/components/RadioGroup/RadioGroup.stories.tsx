import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import RadioGroup from "./RadioGroup";

const meta = {
  title: "Components/RadioGroup",
  component: RadioGroup,
  args: {
    label: "Where should it render?",
    options: [
      { value: "inline", label: "Inline" },
      { value: "modal", label: "Modal" },
      { value: "sheet", label: "Sheet" },
    ],
    value: null,
    onChange: () => {},
  },
} satisfies Meta<typeof RadioGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default: one choice out of a few, controlled, and starting unanswered.
 *  Nothing is pre-selected on purpose, because a group that arrived with a pick
 *  has answered the question for the user. */
export const Default: Story = {
  render: (args) => {
    const [value, setValue] = createSignal<string | null>(null);
    return <RadioGroup {...args} value={value()} onChange={setValue} />;
  },
};

/** Every state at once, which is what the theme toolbar is for: the empty
 *  circle reads against the input surface, the filled one against the accent,
 *  and both have to hold in light and dark. */
export const States: Story = {
  render: (args) => (
    <div style={{ display: "flex", "flex-direction": "column", gap: "var(--tori-space-5)" }}>
      <RadioGroup {...args} label="Nothing chosen" value={null} />
      <RadioGroup {...args} label="Chosen" value="modal" />
      <RadioGroup
        {...args}
        label="One option disabled"
        value="inline"
        options={[
          { value: "inline", label: "Inline" },
          { value: "modal", label: "Modal" },
          { value: "sheet", label: "Sheet", disabled: true },
        ]}
      />
      <RadioGroup {...args} label="Whole group disabled" value="modal" disabled />
    </div>
  ),
};

/** Options with a second line, the shape an agent's question actually takes:
 *  the description is part of the choice rather than a hint about it, so it is
 *  announced with the option and not with the group. */
export const WithDescriptions: Story = {
  render: () => {
    const [value, setValue] = createSignal<string | null>("protocol");
    return (
      <RadioGroup
        label="Which answer channel?"
        value={value()}
        onChange={setValue}
        options={[
          {
            value: "protocol",
            label: "In protocol",
            description: "Answer the can_use_tool question the agent already asked.",
          },
          {
            value: "hook",
            label: "A dedicated hook",
            description: "Intercept the call before the agent's own chain reaches it.",
          },
        ]}
      />
    );
  },
};

/** Laid out in a row, for a short set of short labels. It wraps rather than
 *  overflows, because the labels are the agent's words and their width is not
 *  something the component gets to assume. */
export const Horizontal: Story = {
  render: (args) => {
    const [value, setValue] = createSignal<string | null>("inline");
    return <RadioGroup {...args} value={value()} onChange={setValue} orientation="horizontal" />;
  },
};

/** Four long options stacked, the widest an agent's question is measured to
 *  get (max 4 options, max 4 questions). Here to catch wrapping and the dot
 *  staying on the first line's baseline rather than drifting to the middle. */
export const LongLabels: Story = {
  render: () => {
    const [value, setValue] = createSignal<string | null>(null);
    return (
      <div style={{ "max-width": "420px" }}>
        <RadioGroup
          label="The three sizes need real widths. How should confirm, sheet and wide map?"
          value={value()}
          onChange={setValue}
          options={[
            { value: "a", label: "Keep the three widths the codebase already has, and name them" },
            { value: "b", label: "Collapse to two, since nothing uses the middle one today" },
            { value: "c", label: "Class mapping plus a Storybook eye, since jsdom cannot resolve var()" },
            { value: "d", label: "Do your best" },
          ]}
        />
      </div>
    );
  },
};
