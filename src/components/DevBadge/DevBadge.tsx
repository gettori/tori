import styles from "./DevBadge.module.css";

// Marks a `tauri dev` instance so it cannot be mistaken for the installed
// build: the window title is hidden (Overlay title bar), so the chrome itself
// has to say it. Tree-shaken out of production by the DEV guard.
export default function DevBadge() {
  if (!import.meta.env.DEV) return null;
  return (
    <>
      <div class={styles.stripe} aria-hidden="true" />
      <span class={styles.chip} title="Running from `pnpm tauri dev`">dev</span>
    </>
  );
}
