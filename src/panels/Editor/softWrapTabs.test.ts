import { describe, it, expect } from "vite-plus/test";
import { wrapShownFor, toggledWrap, withoutTab, type WrapOverrides } from "./softWrapTabs";

const A = "/repo/a.ts";
const B = "/repo/b.md";

describe("what a tab is showing", () => {
  it("follows the setting until the tab has an answer of its own", () => {
    expect(wrapShownFor({}, A, false)).toBe(false);
    expect(wrapShownFor({}, A, true)).toBe(true);
  });

  it("prefers the tab's answer, both ways round", () => {
    expect(wrapShownFor({ [A]: true }, A, false)).toBe(true);
    expect(wrapShownFor({ [A]: false }, A, true)).toBe(false);
  });
});

describe("toggling one tab", () => {
  it("flips away from what it is showing, whichever way the setting points", () => {
    expect(toggledWrap({}, A, false)[A]).toBe(true);
    // The case a stored-value flip would get wrong: with the setting already on,
    // the first press has to unwrap rather than no-op.
    expect(toggledWrap({}, A, true)[A]).toBe(false);
  });

  it("leaves every other tab alone, including on the setting", () => {
    const after = toggledWrap({ [B]: false }, A, true);
    expect(after[A]).toBe(false);
    expect(after[B]).toBe(false);
    // B never gained an entry from A's toggle, so it still follows the setting.
    const fresh = toggledWrap({}, A, true);
    expect(B in fresh).toBe(false);
    expect(wrapShownFor(fresh, B, true)).toBe(true);
  });

  it("comes back to where it started on a second press", () => {
    const once = toggledWrap({}, A, true);
    const twice = toggledWrap(once, A, true);
    expect(wrapShownFor(twice, A, true)).toBe(true);
  });

  it("does not mutate what it was given", () => {
    const before: WrapOverrides = { [A]: true };
    toggledWrap(before, A, false);
    expect(before).toEqual({ [A]: true });
  });
});

describe("closing a tab", () => {
  it("drops that tab's answer and nothing else", () => {
    expect(withoutTab({ [A]: true, [B]: false }, A)).toEqual({ [B]: false });
  });

  it("hands back the same object when there was nothing to drop", () => {
    const before: WrapOverrides = { [B]: true };
    expect(withoutTab(before, A)).toBe(before);
  });

  it("leaves a reopened tab following the setting again", () => {
    const closed = withoutTab(toggledWrap({}, A, false), A);
    expect(wrapShownFor(closed, A, false)).toBe(false);
  });
});
