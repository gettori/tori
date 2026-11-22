import { configure, getQueriesForElement } from "@testing-library/dom";
import { flush } from "solid-js";
import { render as mount, type JSX } from "@solidjs/web";
import { mounted } from "./mounted";

export { createEvent, fireEvent, screen, waitFor, within } from "@testing-library/dom";
export { cleanup } from "./mounted";

// Solid 2 defers writes to a microtask, so every dispatched event flushes
// before the test reads the DOM, the ones user-event sends included.
configure({
  eventWrapper: (dispatch) => {
    const result = dispatch();
    flush();
    return result;
  },
});

export function render(ui: () => JSX.Element) {
  const container: HTMLElement = document.body.appendChild(document.createElement("div"));
  const dispose = mount(ui, container);
  let disposed = false;
  const unmount = () => {
    if (disposed) return;
    disposed = true;
    dispose();
  };
  mounted.add({ container, unmount });
  return { container, unmount, ...getQueriesForElement(container) };
}
