import { describe, it, expect } from "vitest";
import { PICKER_ICONS, resolveIcon, searchIcons, fallbackIcon } from "./iconRegistry";

describe("iconRegistry", () => {
  it("exposes 120 ordered, uniquely named icons", () => {
    expect(PICKER_ICONS).toHaveLength(120);
    const names = PICKER_ICONS.map((e) => e.name);
    expect(new Set(names).size).toBe(120);
  });

  it("resolves a known name to its component (hit)", () => {
    const rocket = PICKER_ICONS.find((e) => e.name === "Rocket")!;
    expect(resolveIcon("Rocket")).toBe(rocket.icon);
    expect(resolveIcon("Rocket")).toBeDefined();
  });

  it("returns undefined for an unknown or blank name (graceful miss)", () => {
    expect(resolveIcon("NotAnIcon")).toBeUndefined();
    expect(resolveIcon("")).toBeUndefined();
    expect(resolveIcon(undefined)).toBeUndefined();
    expect(resolveIcon(null)).toBeUndefined();
  });

  it("keeps every icon a space could already be using", () => {
    // The original 40 names are stored in live `tori.toml` files; dropping one
    // in the expansion would silently turn that space's tile back into a letter.
    const original = [
      "Rocket", "Anchor", "Atom", "Award", "Book", "Bookmark", "Box", "Briefcase",
      "Bug", "Camera", "Cloud", "Code", "Coffee", "Compass", "Cpu", "Database",
      "Feather", "Flag", "Flame", "Folder", "Gamepad2", "Gem", "Globe", "Heart",
      "House", "Layers", "Leaf", "Lightbulb", "Map", "Moon", "Music", "Package",
      "Palette", "PenTool", "Rss", "Server", "Star", "Sun", "Terminal", "Zap",
    ];
    for (const name of original) expect(resolveIcon(name)).toBeDefined();
  });

  it("searches case- and separator-insensitively over compound names", () => {
    const hit = (q: string) => searchIcons(q).map((e) => e.name);
    expect(hit("git branch")).toContain("GitBranch");
    expect(hit("GITBRANCH")).toContain("GitBranch");
    expect(hit("fork")).toEqual(["GitFork"]);
    expect(hit("zzzz")).toEqual([]);
  });

  it("returns the whole set for a blank query", () => {
    expect(searchIcons("")).toBe(PICKER_ICONS);
    expect(searchIcons("   ")).toBe(PICKER_ICONS);
  });

  it("picks a stable fallback per seed, and spreads across the set", () => {
    expect(fallbackIcon("/a/b/tori")).toBe(fallbackIcon("/a/b/tori"));
    // Different seeds must land on different glyphs often enough to read as
    // varied: 12 sibling project paths must not collapse onto one icon.
    const seeds = Array.from({ length: 12 }, (_, i) => `/Users/me/Projects/p${i}`);
    expect(new Set(seeds.map(fallbackIcon)).size).toBeGreaterThan(6);
  });
});
