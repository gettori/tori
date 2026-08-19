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
export default function WindowControls(props: { showSidebar: boolean }) {
  return (
    <div class={styles.winControls}>
      <div class={styles.toggleSlot}>
        <LayoutToggles showSidebar={props.showSidebar} />
      </div>
      <div class={styles.navSlot} ref={(el) => el.appendChild(stageHost("editor-nav"))} />
    </div>
  );
}
