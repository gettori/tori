/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { applyCachedTheme } from "./theme";

// Paint with the last-known theme synchronously, before first render.
applyCachedTheme();

// Dev-only: swap between the app and the #styleguide surface on hash change
// (there is no router; App reads location.hash to decide what to render).
if (import.meta.env.DEV) {
  window.addEventListener("hashchange", () => location.reload());
}

render(() => <App />, document.getElementById("root") as HTMLElement);
