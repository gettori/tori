import { describe, it, expect } from "vitest";

/** `OverflowTabBar` as text. Vite's own glob rather than `node:fs`, the way
 *  `boundary.test.ts` does it, so no `@types/node` is needed. */
const BAR = Object.values(
  import.meta.glob<string>("../components/OverflowTabBar.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)[0];

/** Ways to make a flag outlive the listener that set it. `requestAnimationFrame`
 *  is absent on purpose: the bar measures in one, which is a different job. */
const DEFERRALS = [
  "queueMicrotask",
  "setTimeout",
  "setInterval",
  "requestIdleCallback",
  "Promise.resolve()",
];

describe("the tab bar's activation gate", () => {
  it("reads the file it is meant to police", () => {
    // A guard that quietly matches nothing passes forever.
    expect(BAR).toBeTypeOf("string");
    expect(BAR).toContain("OverflowTabBar");
  });

  it("defers the gate to tabGesture rather than keeping its own flag", () => {
    expect(BAR).toContain('from "../utils/tabGesture"');
    expect(BAR).toContain("gesture.live()");
  });

  it("holds no deferred clear of its own", () => {
    // The regression this exists for cannot be reproduced in jsdom, which is the
    // whole reason it is a source guard. The bar used to set a flag in a capture
    // listener and clear it in a `queueMicrotask`; a browser runs a microtask
    // checkpoint after every listener callback of a user-initiated dispatch, so
    // the flag was gone before Kobalte's handler ran and no tab could be clicked
    // in the app - while every `fireEvent` test stayed green, because a scripted
    // dispatch never lets the stack empty. Any timer put back here would fail
    // the same way and pass the same tests.
    const found = DEFERRALS.filter((d) => BAR.includes(d));
    expect(found).toEqual([]);
  });
});
