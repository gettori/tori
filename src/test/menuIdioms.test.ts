// The guard for the two test idioms gettori/tori issue 103 had to sweep, so
// they stay swept.
//
// Both exist because the menus moved from hand-rolled DOM onto Kobalte, and
// both fail *quietly* rather than loudly, which is why they get a guard instead
// of a note.
//
//   1. **`fireEvent.click` reaches nothing in a menu.** A trigger opens on
//      `pointerdown`; a row runs its action on `pointerup` with `button === 0`,
//      or on Enter/Space. A bare click reaches both and changes neither, so the
//      test reads as "the menu did not open" or "the action did not fire"
//      rather than as the wrong event. `pointerClick` in `./menus.ts` is the
//      replacement.
//   2. **`mousedown` dismisses nothing.** Kobalte's dismissable layer listens
//      for `pointerdown`, and installs that listener from a `setTimeout(0)`, so
//      a dismissal test also has to yield a macrotask first. The pre-migration
//      surfaces composed `Popover`, which listens for `mousedown`, so every
//      dismissal assertion in the repo was written that way.
//
// A `mouseDown` **paired** with a `pointerDown` is fine and is what the
// migrated tests do: it spells out the pair a real pointer sends, and asserts
// the closing rather than the mechanism. What this flags is a `mouseDown` that
// is the only event in play, because that one passes today only if whatever it
// is dismissing is not a menu.
//
// Scope is `src/`, both extensions, because `./menus.ts` and its callers are
// split across the two vitest projects. This file excludes itself: a
// source-scanning test that reads its own regexes reports itself, which is a
// gotcha the vault already records.
import { describe, expect, it } from "vite-plus/test";

const SELF = "test/menuIdioms.test.ts";

const SOURCES = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../**/*.{ts,tsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  )
    .map(([path, source]) => [path.replace(/^\.\.\//, ""), source] as const)
    .filter(([path]) => path !== SELF),
);

/** A `fireEvent.mouseDown` with no `pointerDown` beside it, in a file where
 *  that is correct, and why it is correct there. */
const LONE_MOUSEDOWN = new Map<string, string>([
  [
    "panels/Settings/settingsPanel.test.tsx",
    "the Settings backdrop, which is a panel's own dismissal and has never involved a menu",
  ],
]);

/** How close a `pointerDown` has to be to count as pairing with a `mouseDown`.
 *  They are written adjacent, and a window wide enough to span an unrelated
 *  block would make the pairing meaningless. */
const PAIRED_WITHIN = 3;

const lines = (source: string) => source.split("\n");

describe("the test idioms the Kobalte menus need", () => {
  it("drives no menu with a plain click", () => {
    const found: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      lines(source).forEach((line, i) => {
        if (!line.includes("fireEvent.click")) return;
        // The line names a menu role, so whatever it is clicking is a menu
        // surface and a click is the wrong event for it.
        if (!/menuitem|role=.menu|getByRole\(.menu/.test(line)) return;
        found.push(`${path}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  it("never leaves a mousedown as the only thing dismissing something", () => {
    const found: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      if (LONE_MOUSEDOWN.has(path)) continue;
      const all = lines(source);
      all.forEach((line, i) => {
        if (!line.includes("fireEvent.mouseDown")) return;
        const near = all.slice(Math.max(0, i - PAIRED_WITHIN), i + PAIRED_WITHIN + 1).join("\n");
        if (near.includes("pointerDown")) return;
        found.push(`${path}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  it("keeps every exemption pointing at a file that still has one", () => {
    // An exemption outliving its `mouseDown` is how a list like this rots into
    // a blanket permission for a file.
    for (const [path] of LONE_MOUSEDOWN) {
      expect(SOURCES[path], `${path} is exempted but no longer exists`).toBeTruthy();
      expect(SOURCES[path], `${path} is exempted but has no lone mouseDown left`).toContain("fireEvent.mouseDown");
    }
  });
});
