import { getCurrentWindow } from "@tauri-apps/api/window";
import styles from "./WindowControls.module.css";

// Custom macOS-style traffic lights: smaller than native, vertically centered,
// and gray until the group is hovered. The native buttons are hidden in Rust
// (see lib.rs setup); these are wired to the same window actions.
export default function WindowControls() {
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
    </div>
  );
}
