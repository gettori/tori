/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import "../../src/styles/reset.css";
import "../../src/styles/tokens.css";
import "../../src/styles/base.css";

render(() => <App />, document.getElementById("root") as HTMLElement);
