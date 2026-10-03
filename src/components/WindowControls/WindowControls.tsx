import { children, type JSX } from "solid-js";
import LayoutToggles from "../LayoutToggles/LayoutToggles";
import { stageHost } from "../../tabs/stageHost";
import styles from "./WindowControls.module.css";

// The top-left cluster of the titlebar. It draws no window controls: the traffic
// lights are the system's own (placed by `trafficLightPosition` in
// tauri.conf.json), because everything AppKit attaches to them - the hover
// tiling menu, option-click close-all / minimize-all / zoom, the hover glyphs,
// focus dimming, accessibility - is unreachable from the web layer. What this
// owns is the space they sit in, the sidebar toggle at their right, and the
// editor's jump navigation at the far end of the rail (phase 13), which the
// editor portals in through a stage host.
export default function WindowControls(props: {
  showSidebar: boolean;
  /** What the hidden sidebar would have told you, joined onto its toggle. */
  status?: JSX.Element;
}) {
  // Resolved once: the status renders nothing while no session is live, and the
  // pill has to follow what it actually rendered, not whether it was passed.
  const status = children(() => props.status);
  const joined = () => status.toArray().some((c) => c != null);
  return (
    <div class={styles.winControls}>
      <div class={styles.toggleSlot} classList={{ [styles.joined]: joined() }}>
        <LayoutToggles showSidebar={props.showSidebar} />
        {status()}
      </div>
      <div class={styles.navSlot} ref={(el) => el.appendChild(stageHost("editor-nav"))} />
    </div>
  );
}
