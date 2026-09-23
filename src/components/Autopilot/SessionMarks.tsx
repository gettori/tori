import { Lock } from "lucide-solid";
import Icon from "../Icon/Icon";
import Wheel from "./Wheel";
import styles from "./SessionMarks.module.css";

/** Leads a row the autopilot started: turning while it drives the session,
 *  still and quiet once it no longer does. */
export function StartedMark(props: { driving: boolean }) {
  return <Wheel state={props.driving ? "working" : "idle"} quiet={!props.driving} size={11} />;
}

/** Stands in for a row's timestamp while the autopilot holds the session. */
export function LockMark() {
  return (
    <span class={styles.lock} role="img" aria-label="Locked, the autopilot is driving">
      <Icon icon={Lock} class={styles.lockIcon} />
    </span>
  );
}

/** Top right of a pane the autopilot is driving. */
export function DrivingTag() {
  return (
    <span class={styles.tag}>
      <Wheel state="working" size={12} />
      Autopilot driving
    </span>
  );
}

/** Under the title bar while the autopilot drives the session in view. */
export function DrivingHairline() {
  return <span class={styles.hairline} aria-hidden="true" />;
}
