import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { For, type JSX } from "solid-js";
import AutopilotPopup from "./AutopilotPopup";
import AutopilotSwitch from "./AutopilotSwitch";
import AutopilotView from "./AutopilotView";
import Horizon, { SCENE_KEYS } from "./Horizon";
import type { AutopilotState } from "./autopilot";
import { POPUP, VIEW } from "./shellFixtures";

// The two static shells in every state, on fake data. #205 feeds them from the
// autopilot's session and state store; nothing here reaches either.

const meta = {
  title: "Autopilot/Shells",
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The Autopilot view under a title bar carrying the switch, as the window draws it. */
function Window(props: { state: AutopilotState; children: JSX.Element }) {
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        width: "1280px",
        height: "780px",
        border: "var(--tori-border-thin) solid var(--border-default)",
      }}
    >
      <div
        style={{
          display: "flex",
          "justify-content": "center",
          "align-items": "center",
          flex: "none",
          height: "38px",
          background: "var(--canvas-card)",
          "border-bottom": "var(--tori-border-thin) solid var(--border-default)",
        }}
      >
        <AutopilotSwitch view="autopilot" state={props.state} count={VIEW[props.state].decisions.length || 2} />
      </div>
      <div style={{ flex: "1", "min-height": "0" }}>{props.children}</div>
    </div>
  );
}

const view = (state: AutopilotState): Story => ({
  render: () => (
    <Window state={state}>
      <AutopilotView {...VIEW[state]} />
    </Window>
  ),
});

export const ViewOff = view("off");
export const ViewIdle = view("idle");
export const ViewWorking = view("working");
export const ViewNeedsYou = view("needs");

/** Every time of day the banner can show, from dawn to night. */
export const Scenes: Story = {
  render: () => (
    <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
      <For each={SCENE_KEYS}>
        {(scene) => (
          <div style={{ position: "relative", height: "176px" }}>
            <Horizon scene={scene} />
          </div>
        )}
      </For>
    </div>
  ),
};
export const ViewError = view("error");

/** The popup as it drops under the switch; the dimmed editor behind it is the host's. */
const popup = (state: AutopilotState): Story => ({
  render: () => (
    <div style={{ height: "700px" }}>
      <AutopilotPopup {...POPUP[state]} />
    </div>
  ),
});

export const PopupOff = popup("off");
export const PopupIdle = popup("idle");
export const PopupWorking = popup("working");
export const PopupNeedsYou = popup("needs");
export const PopupError = popup("error");
