import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { For } from "solid-js";
import Wheel from "./Wheel";
import { AUTOPILOT_STATES } from "./autopilot";

// Reduced motion is the OS setting, not a prop: emulate it in the browser's
// rendering tools and the working wheel stops and grows its dot.

const row = { display: "flex", gap: "var(--tori-space-7)", "align-items": "center" } as const;
const cell = {
  display: "flex",
  "flex-direction": "column",
  "align-items": "center",
  gap: "var(--tori-space-4)",
  "font-size": "var(--tori-text-xs)",
  color: "var(--fg-muted)",
} as const;

const meta = {
  title: "Autopilot/Wheel",
  component: Wheel,
  argTypes: {
    state: { control: "select", options: AUTOPILOT_STATES },
    count: { control: "number" },
    active: { control: "boolean" },
    size: { control: "number" },
  },
  args: { state: "working", count: 2, active: false, size: 14 },
} satisfies Meta<typeof Wheel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** The five states side by side, each told apart by shape. */
export const States: Story = {
  render: () => (
    <div style={row}>
      <For each={AUTOPILOT_STATES}>
        {(state) => (
          <div style={cell}>
            <Wheel state={state} count={2} size={28} />
            {state}
          </div>
        )}
      </For>
    </div>
  ),
};

/** The same states on an active switch segment, where idle and working take the tint's text. */
export const OnActiveSegment: Story = {
  render: () => (
    <div style={row}>
      <For each={AUTOPILOT_STATES}>
        {(state) => (
          <span
            style={{
              display: "inline-flex",
              padding: "var(--tori-space-3)",
              "border-radius": "var(--tori-radius-pill)",
              background: "var(--progress-subtle)",
              "--wheel-ring": "var(--progress-subtle)",
            }}
          >
            <Wheel state={state} count={2} active />
          </span>
        )}
      </For>
    </div>
  ),
};

/** The badge from one to past nine, where it stops counting. */
export const BadgeCounts: Story = {
  render: () => (
    <div style={row}>
      <For each={[1, 2, 9, 12]}>
        {(count) => (
          <div style={cell}>
            <Wheel state="needs" count={count} />
            {count}
          </div>
        )}
      </For>
    </div>
  ),
};

/** The sizes it is drawn at: a sidebar row, the switch, and the popup's header tile. */
export const Sizes: Story = {
  render: () => (
    <div style={row}>
      <For each={[11, 14, 30]}>
        {(size) => (
          <div style={cell}>
            <Wheel state="needs" count={2} size={size} />
            {size}px
          </div>
        )}
      </For>
    </div>
  ),
};
