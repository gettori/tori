import { getCurrentWindow } from "@tauri-apps/api/window";
import LayoutToggles from "../LayoutToggles/LayoutToggles";
import styles from "./WindowControls.module.css";

// Custom macOS-style traffic lights: smaller than native, vertically centered,
// and gray until the group is hovered. The native buttons are hidden in Rust
// (see lib.rs setup); these are wired to the same window actions. The pane
// show/hide toggles ride alongside them to the right, so the whole top-left
// cluster (what the topbar rail measures) is one group.
export default function WindowControls(props: {
  showSidebar: boolean;
  showTerminal: boolean;
  showEditor: boolean;
}) {
  const win = getCurrentWindow();
  return (
    <div class={styles.winControls}>
      <button
        class={`${styles.winDot} ${styles.close}`}
        aria-label="Close"
        onClick={() => win.close()}
      />
      <button
        class={`${styles.winDot} ${styles.min}`}
        aria-label="Minimize"
        onClick={() => win.minimize()}
      />
      <button
        class={`${styles.winDot} ${styles.zoom}`}
        aria-label="Zoom"
        onClick={() => win.toggleMaximize()}
      />
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
