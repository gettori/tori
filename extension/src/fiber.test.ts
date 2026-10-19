import { describe, it, expect } from "vite-plus/test";
import { shallowProps } from "./fiber";

const named = (name: string) => Object.assign(() => null, { displayName: name });

describe("shallowProps", () => {
  it("previews each kind of value and drops children", () => {
    const element = { $$typeof: Symbol.for("react.transitional.element"), type: named("Icon") };
    expect(
      shallowProps(
        { label: "Pay", count: 3, onClick: () => {}, icon: element, items: [1, 2], style: { gap: 4 }, children: "x" },
        false,
      ),
    ).toEqual({ label: '"Pay"', count: "3", onClick: "fn", icon: "<Icon>", items: "[2]", style: "{gap}" });
  });

  it("redacts secret looking keys, and every value on a sensitive element", () => {
    expect(shallowProps({ password: "hunter2", apiKey: "k", label: "Pay" }, false)).toEqual({
      password: "[redacted]",
      apiKey: "[redacted]",
      label: '"Pay"',
    });
    expect(shallowProps({ value: "hunter2", onChange: () => {} }, true)).toEqual({
      value: "[redacted]",
      onChange: "fn",
    });
  });

  it("cuts long strings and keeps at most 20 props", () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p${i}`, i]));
    expect(Object.keys(shallowProps(many, false))).toHaveLength(20);
    expect(shallowProps({ text: "a".repeat(300) }, false).text).toBe(`"${"a".repeat(200)}..."`);
  });
});
