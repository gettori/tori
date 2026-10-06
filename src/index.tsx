/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { applyCachedTheme } from "./theme";
import { installTrace } from "./utils/perfTrace";
import { installCrashReport } from "./utils/crashReport";
import { isMac } from "./utils/platform";

// Paint with the last-known theme synchronously, before first render.
applyCachedTheme();

// For the CSS that lays out around macOS's overlay title bar.
document.documentElement.dataset.os = isMac ? "mac" : "other";

// Uncaught errors and rejections go to ~/.config/tori/crashes beside the
// backend's panic files. Before render, so a throw in the first frame counts.
installCrashReport();

// Performance tracing, if the backend was launched with TORI_TRACE. Started
// here rather than in a component so the IPC shim is installed as early as it
// can be; it is off in every ordinary launch and costs one command to find out.
void installTrace();

// Dev-only: swap between the app and the #styleguide surface on hash change
// (there is no router; App reads location.hash to decide what to render).
if (import.meta.env.DEV) {
  window.addEventListener("hashchange", () => location.reload());
}

render(() => <App />, document.getElementById("root") as HTMLElement);
