import styles from "./DevBadge.module.css";

// Marks a `tauri dev` instance so it cannot be mistaken for the installed
// build: the window title is hidden (Overlay title bar), so the chrome itself
// has to say it. Tree-shaken out of production by the DEV guard.
//
// The stripe alone. There was a "dev" chip in the topbar beside it, saying the
// same thing a second time and taking a slot from the bar's own controls; two
// markers for one fact is one more than the fact needs.
export default function DevBadge() {
  if (!import.meta.env.DEV) return null;
  return <div class={styles.stripe} aria-hidden="true" />;
}
