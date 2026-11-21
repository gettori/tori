import { configure, getQueriesForElement } from "@testing-library/dom";
import type { JSX } from "solid-js";
import { render as mount } from "solid-js/web";

export { createEvent, fireEvent, screen, waitFor, within } from "@testing-library/dom";

// Solid 2 defers writes to a microtask, so its flush() goes here and every
// dispatched event picks it up, the ones user-event sends included.
configure({ eventWrapper: (dispatch) => dispatch() });

interface Mounted {
  container: HTMLElement;
  unmount: () => void;
}

const mounted = new Set<Mounted>();

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

export function cleanup() {
  for (const { container, unmount } of mounted) {
    unmount();
    container.remove();
  }
  mounted.clear();
}
