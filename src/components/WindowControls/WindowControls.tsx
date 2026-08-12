import LayoutToggles from "../LayoutToggles/LayoutToggles";
import styles from "./WindowControls.module.css";

// The top-left cluster of the titlebar. It draws no window controls: the traffic
// lights are the system's own (placed by `trafficLightPosition` in
// tauri.conf.json), because everything AppKit attaches to them - the hover
// tiling menu, option-click close-all / minimize-all / zoom, the hover glyphs,
// focus dimming, accessibility - is unreachable from the web layer. What this
// owns is the space they sit in, and the pane show/hide toggles to their right,
// so the whole cluster (what the topbar rail measures) is one group.
export default function WindowControls(props: {
  showSidebar: boolean;
  showTerminal: boolean;
  showEditor: boolean;
}) {
  return (
    <div class={styles.winControls}>
      <div class={styles.toggleSlot}>
        <LayoutToggles
          showSidebar={props.showSidebar}
          showTerminal={props.showTerminal}
          showEditor={props.showEditor}
        />
      </div>
    </div>
  );
}
