import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import CheckboxGroup from "./CheckboxGroup";

const meta = {
  title: "Components/CheckboxGroup",
  component: CheckboxGroup,
  args: {
    label: "Which should I address?",
    options: [
      { value: "check", label: "Add check 9 for the title copy" },
      { value: "comment", label: "Comment the keyframe coupling" },
      { value: "leave", label: "Leave all three" },
    ],
    value: [],
    onChange: () => {},
  },
} satisfies Meta<typeof CheckboxGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default: any number of choices out of a few. Starts empty, because a
 *  group that arrived with picks has answered for the user. */
export const Default: Story = {
  render: (args) => {
    const [value, setValue] = createSignal<string[]>([]);
    return <CheckboxGroup {...args} value={value()} onChange={setValue} />;
  },
};

/** Every state at once, next to the radio group's equivalent story so the two
 *  can be compared: they share a rhythm on purpose, since one question form can
 *  render both. */
export const States: Story = {
  render: (args) => (
    <div style={{ display: "flex", "flex-direction": "column", gap: "var(--tori-space-5)" }}>
      <CheckboxGroup {...args} label="Nothing chosen" value={[]} />
      <CheckboxGroup {...args} label="Some chosen" value={["check", "comment"]} />
      <CheckboxGroup
        {...args}
        label="One option disabled"
        value={["check"]}
        options={[
          { value: "check", label: "Add check 9 for the title copy" },
          { value: "comment", label: "Comment the keyframe coupling" },
          { value: "leave", label: "Leave all three", disabled: true },
        ]}
      />
      <CheckboxGroup {...args} label="Whole group disabled" value={["comment"]} disabled />
    </div>
  ),
};

/** Options with a second line. The description hangs under the label, not under
 *  the tick, so it reads as belonging to the words rather than as another
 *  option. */
export const WithDescriptions: Story = {
  render: () => {
    const [value, setValue] = createSignal<string[]>(["motion"]);
    return (
      <CheckboxGroup
        label="Which animations keep running when reduced motion is on?"
        value={value()}
        onChange={setValue}
        options={[
          {
            value: "motion",
            label: "The status dot",
            description: "Conveys liveness, so stopping it loses information.",
          },
          {
            value: "spinner",
            label: "The spinner",
            description: "Decorative once the status text is there.",
          },
          {
            value: "toast",
            label: "Toast entry",
            description: "Motion is the only thing that draws the eye to it.",
          },
        ]}
      />
    );
  },
};
