/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { applyCachedTheme } from "./theme";

// Paint with the last-known theme synchronously, before first render.
applyCachedTheme();

render(() => <App />, document.getElementById("root") as HTMLElement);
