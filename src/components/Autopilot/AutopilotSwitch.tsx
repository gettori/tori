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
  /** Stop when on, Start when off. */
  onToggleOn?: () => void;
}

/** The title bar control: which view is showing, with the autopilot's state on
 *  its wheel, and the round button that stops or starts it. Off, only the
 *  button shows: there is no cockpit to switch to. */
export default function AutopilotSwitch(props: AutopilotSwitchProps) {
  const onAutopilot = () => props.view === "autopilot";
  const on = () => props.state !== "off";

  return (
    <div class={styles.switch}>
      <Show when={on()}>
        <div
          class={styles.pill}
          data-state={props.state}
          data-view={props.view}
          role="group"
          aria-label="Autopilot"
        >
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
              Cockpit
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
              Workspace
            </Tooltip>
          </Show>
        </div>
      </Show>

      <Tooltip
        as="button"
        type="button"
        class={styles.power}
        data-on={on() ? "true" : "false"}
        label={on() ? "Stop autopilot" : "Start autopilot"}
        onClick={() => props.onToggleOn?.()}
      >
        <Show when={on()} fallback={<span class={styles.play} />}>
          <span class={styles.stop} />
        </Show>
      </Tooltip>
    </div>
  );
}
