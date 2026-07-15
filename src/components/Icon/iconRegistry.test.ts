import { describe, it, expect } from "vitest";
import { SPACE_ICONS, resolveIcon } from "./iconRegistry";

describe("iconRegistry", () => {
  it("exposes 40 ordered, uniquely named icons", () => {
    expect(SPACE_ICONS).toHaveLength(40);
    const names = SPACE_ICONS.map((e) => e.name);
    expect(new Set(names).size).toBe(40);
  });

  it("resolves a known name to its component (hit)", () => {
    const rocket = SPACE_ICONS.find((e) => e.name === "Rocket")!;
    expect(resolveIcon("Rocket")).toBe(rocket.icon);
    expect(resolveIcon("Rocket")).toBeDefined();
  });

  it("returns undefined for an unknown or blank name (graceful miss)", () => {
    expect(resolveIcon("NotAnIcon")).toBeUndefined();
    expect(resolveIcon("")).toBeUndefined();
    expect(resolveIcon(undefined)).toBeUndefined();
    expect(resolveIcon(null)).toBeUndefined();
  });
});
