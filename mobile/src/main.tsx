/* @refresh reload */
import { render } from "@solidjs/web";
import App from "./App";
import { paintTheme, theme } from "./prefs";
import "../../src/styles/reset.css";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";

paintTheme(theme());
render(() => <App />, document.getElementById("root") as HTMLElement);
