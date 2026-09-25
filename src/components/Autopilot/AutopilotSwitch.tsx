import { Show } from "solid-js";
import { PanelLeft } from "lucide-solid";
import Icon from "../Icon/Icon";
import Tooltip from "../Tooltip/Tooltip";
import Wheel from "./Wheel";
import type { AutopilotState, AutopilotView } from "./autopilot";
import styles from "./AutopilotSwitch.module.css";

export interface AutopilotSwitchProps {
  view: AutopilotView;
  state: AutopilotState;
  /** Pending decisions, for the wheel's badge. */
  count?: number;
  /** The Workspace popup is showing. Only meaningful in the workspace view. */
  popupOpen?: boolean;
  onSelectView?: (view: AutopilotView) => void;
  /** Clicking the already active Workspace segment toggles the popup. */
  onTogglePopup?: () => void;
}

/** A segment's label, as wide as the widest one, so the pill keeps one width
 *  whichever view is showing. */
function Label(props: { text: string }) {
  return (
    <span class={styles.label} data-widest="Workspace">
      <span>{props.text}</span>
    </span>
  );
}

/** The title bar control: which view is showing, with the autopilot's state on
 *  its wheel. Starting and stopping it is the cockpit's. */
export default function AutopilotSwitch(props: AutopilotSwitchProps) {
  const onAutopilot = () => props.view === "autopilot";

  return (
    <div class={styles.pill} data-state={props.state} data-view={props.view} role="group" aria-label="Autopilot">
      <Show
        when={onAutopilot()}
        fallback={
          <Tooltip
            as="button"
            type="button"
            class={styles.segment}
            label={"Cockpit (\u2318\u21e7J)"}
            aria-pressed="false"
            onClick={() => props.onSelectView?.("autopilot")}
          >
            <Wheel state={props.state} count={props.count} />
          </Tooltip>
        }
      >
        <button type="button" class={`${styles.segment} ${styles.active}`} aria-pressed="true">
          <Wheel state={props.state} count={props.count} active />
          <Label text="Cockpit" />
        </button>
      </Show>

      <Show
        when={!onAutopilot()}
        fallback={
          <Tooltip
            as="button"
            type="button"
            class={styles.segment}
            label={"Workspace (\u2318\u21e7J)"}
            aria-pressed="false"
            onClick={() => props.onSelectView?.("workspace")}
          >
            <Icon icon={PanelLeft} class={styles.icon} />
          </Tooltip>
        }
      >
        <Tooltip
          as="button"
          type="button"
          class={`${styles.segment} ${styles.active}`}
          classList={{ [styles.open]: !!props.popupOpen }}
          label={props.popupOpen ? "Hide autopilot (\u2318L)" : "Show autopilot (\u2318L)"}
          aria-pressed="true"
          aria-expanded={!!props.popupOpen}
          onClick={() => props.onTogglePopup?.()}
        >
          <Icon icon={PanelLeft} class={styles.icon} />
          <Label text="Workspace" />
        </Tooltip>
      </Show>
    </div>
  );
}
