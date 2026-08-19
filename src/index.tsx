/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { applyCachedTheme } from "./theme";
import { installTrace } from "./utils/perfTrace";

// Paint with the last-known theme synchronously, before first render.
applyCachedTheme();

// Performance tracing, if the backend was launched with SWAY_TRACE. Started
// here rather than in a component so the IPC shim is installed as early as it
// can be; it is off in every ordinary launch and costs one command to find out.
void installTrace();

// Dev-only: swap between the app and the #styleguide surface on hash change
// (there is no router; App reads location.hash to decide what to render).
if (import.meta.env.DEV) {
  window.addEventListener("hashchange", () => location.reload());
}

render(() => <App />, document.getElementById("root") as HTMLElement);
