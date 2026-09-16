import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import Slider from "./Slider";

const meta = {
  title: "Components/Slider",
  component: Slider,
  args: {
    label: "UI scale",
    value: 1,
    min: 0.85,
    max: 1.4,
    step: 0.05,
    onChange: () => {},
  },
} satisfies Meta<typeof Slider>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default, at the proportions the ui-scale control uses. */
export const Default: Story = {
  render: (args) => {
    const [value, setValue] = createSignal(1);
    return (
      <div style={{ width: "320px" }}>
        <Slider {...args} value={value()} onChange={setValue} />
      </div>
    );
  },
};

/** The live-preview contract, made visible: `onChange` fires on every step, so
 *  the number beside the track keeps up with the thumb instead of waiting for
 *  the drag to end. */
export const LivePreview: Story = {
  render: (args) => {
    const [value, setValue] = createSignal(1);
    return (
      <div style={{ width: "320px" }}>
        <Slider {...args} value={value()} onChange={setValue} />
        <div
          style={{
            "margin-top": "var(--tori-space-3)",
            color: "var(--fg-muted)",
            "font-size": "var(--tori-text-sm)",
          }}
        >
          {value().toFixed(2)}x
        </div>
      </div>
    );
  },
};

/** Track, fill and thumb at both ends and disabled, which is where the fill's
 *  accent against the neutral track has to hold in either theme. */
export const States: Story = {
  render: (args) => (
    <div
      style={{
        width: "320px",
        display: "flex",
        "flex-direction": "column",
        gap: "var(--tori-space-5)",
      }}
    >
      <Slider {...args} value={0.85} label="At minimum" />
      <Slider {...args} value={1.4} label="At maximum" />
      <Slider {...args} value={1.1} label="Disabled" disabled />
    </div>
  ),
};
