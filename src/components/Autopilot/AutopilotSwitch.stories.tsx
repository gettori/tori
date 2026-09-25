import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal, For, type JSX } from "solid-js";
import AutopilotSwitch from "./AutopilotSwitch";
import { AUTOPILOT_STATES, type AutopilotState, type AutopilotView } from "./autopilot";

// The switch lives in the title bar, which paints `canvas-card`, so every
// story sits on that strip rather than on the workshop's canvas.

const TitleBar = (props: { children: JSX.Element }) => (
  <div
    style={{
      display: "inline-flex",
      "align-items": "center",
      padding: "var(--tori-space-2) var(--tori-space-5)",
      background: "var(--canvas-card)",
      "border-bottom": "var(--tori-border-thin) solid var(--border-default)",
    }}
  >
    {props.children}
  </div>
);

const meta = {
  title: "Autopilot/AutopilotSwitch",
  component: AutopilotSwitch,
  argTypes: {
    view: { control: "inline-radio", options: ["autopilot", "workspace"] },
    state: { control: "select", options: AUTOPILOT_STATES },
    count: { control: "number" },
    popupOpen: { control: "boolean" },
  },
  args: { view: "workspace", state: "working", count: 2, popupOpen: false },
  decorators: [(Story) => <TitleBar><Story /></TitleBar>],
} satisfies Meta<typeof AutopilotSwitch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** Live: switch views and open the popup from the active Workspace segment. */
export const Interactive: Story = {
  render: () => {
    const [view, setView] = createSignal<AutopilotView>("workspace");
    const [state] = createSignal<AutopilotState>("needs");
    const [open, setOpen] = createSignal(false);
    return (
      <AutopilotSwitch
        view={view()}
        state={state()}
        count={2}
        popupOpen={view() === "workspace" && open()}
        onSelectView={(v) => {
          setView(v);
          setOpen(false);
        }}
        onTogglePopup={() => setOpen(!open())}
      />
    );
  },
};

const grid = {
  display: "grid",
  "grid-template-columns": "auto auto",
  gap: "var(--tori-space-5) var(--tori-space-7)",
  "align-items": "center",
  "font-size": "var(--tori-text-xs)",
  color: "var(--fg-muted)",
} as const;

/** Every state in both views. */
export const ViewByState: Story = {
  decorators: [],
  render: () => (
    <div style={grid}>
      <For each={AUTOPILOT_STATES}>
        {(state) => (
          <>
            <TitleBar>
              <AutopilotSwitch view="autopilot" state={state} count={2} />
            </TitleBar>
            <TitleBar>
              <AutopilotSwitch view="workspace" state={state} count={2} />
            </TitleBar>
          </>
        )}
      </For>
    </div>
  ),
};

/** Workspace with the popup showing: the ring marks the segment that opened it. */
export const PopupOpen: Story = {
  args: { view: "workspace", state: "needs", count: 2, popupOpen: true },
};
