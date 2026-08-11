// The Settings panel's header search: which rows a query matches, and how many
// land in each tab.
//
// Row granularity is the contract, not an implementation detail: the count
// badges on the tab strip are the reason it is not section-level, and a badge
// has to equal the number of rows the pane then shows. The section-level
// assertions this file used to carry retired with `matchingSections` when the
// panel switched over; the concern behind them (a match keeps the context around
// it) is now a rendering property, checked in `settingsPanel.test.tsx`.
import { describe, it, expect } from "vitest";
import { matchingEntries } from "./settingsSearch";
import { SETTINGS, SETTING_TABS, TAB_OF_SECTION } from "../../utils/settingsCatalog";

describe("counting the settings a query matches, per row and per tab", () => {
  /** The tabs a query put a non-zero badge on, which is what the strip shows. */
  const badged = (query: string) =>
    Object.entries(matchingEntries(query)!.counts)
      .filter(([, n]) => n > 0)
      .map(([tab]) => tab);

  it("shows everything when nothing is typed", () => {
    // Same `null` convention as `matchingSections`, and for the same reason: a
    // record of zeroes reads as "nothing matched", which is a different screen.
    expect(matchingEntries("")).toBeNull();
    expect(matchingEntries("   ")).toBeNull();
  });

  it("finds a row by a fragment of its label and counts it against its tab", () => {
    const m = matchingEntries("minimap")!;
    expect(m.ids).toEqual(new Set(["minimap"]));
    expect(m.total).toBe(1);
    expect(m.counts.editor).toBe(1);
    expect(badged("minimap")).toEqual(["editor"]);
  });

  it("matches a label loosely, the way the palette does", () => {
    expect(matchingEntries("sfw")!.ids.has("soft-wrap")).toBe(true);
  });

  it("finds a row by its hint alone, and quotes the hint rather than guessing", () => {
    // "Prettier" appears only in Format on save's explanation, never in a label.
    const m = matchingEntries("Prettier")!;
    expect(m.ids).toEqual(new Set(["format-on-save"]));
    // Loosely matched, a hundred characters of prose answer almost any query,
    // so a hint has to be quoted. `ptr` is a subsequence of that hint.
    expect(matchingEntries("ptr")!.ids.has("format-on-save")).toBe(false);
  });

  it("answers zero everywhere for a query nothing matches", () => {
    const m = matchingEntries("zzzqqq")!;
    expect(m.ids.size).toBe(0);
    expect(m.total).toBe(0);
    // Every tab is still present, at zero: the strip dims them, it does not
    // drop them, so it needs a number rather than a missing key.
    expect(Object.keys(m.counts).sort()).toEqual(SETTING_TABS.map((t) => t.id).sort());
    expect(Object.values(m.counts).every((n) => n === 0)).toBe(true);
  });

  it("aggregates across tabs when a query matches rows in more than one", () => {
    // "font" is six typography rows in Appearance and none anywhere else;
    // "stop" reaches the two dollar ceilings and the context one, all in Chat.
    const fonts = matchingEntries("font family")!;
    expect(fonts.counts.appearance).toBe(3);
    expect(badged("font family")).toEqual(["appearance"]);

    const stop = matchingEntries("Dollars")!;
    expect(stop.counts.chat).toBe(2);
    expect(badged("Dollars")).toEqual(["chat"]);
  });

  it("counts a card section once, however many cards it draws", () => {
    // Agents, language servers, debuggers and GitHub render a control per thing
    // found at runtime. Each carries one catalogue entry standing for the
    // section, so the badge counts one, not one per agent installed.
    const m = matchingEntries("Which debug adapters are installed")!;
    expect(m.ids).toEqual(new Set(["debuggers"]));
    expect(m.counts.languages).toBe(1);
  });

  it("counts a matched row exactly once, in exactly one tab", () => {
    // The invariant behind every badge: the totals across the strip add up to
    // the number of rows highlighted in the panes.
    for (const query of ["e", "on", "the", "font", "chat"]) {
      const m = matchingEntries(query)!;
      const summed = Object.values(m.counts).reduce((a, b) => a + b, 0);
      expect(summed, `${query} double-counts or loses a row`).toBe(m.ids.size);
    }
  });

  it("never counts a row against a tab that does not show it", () => {
    const m = matchingEntries("e")!;
    const expected: Record<string, number> = Object.fromEntries(SETTING_TABS.map((t) => [t.id, 0]));
    for (const s of SETTINGS) if (m.ids.has(s.id)) expected[TAB_OF_SECTION[s.section]] += 1;
    expect(m.counts).toEqual(expected);
  });

  it("ignores case and surrounding space", () => {
    expect(matchingEntries("  MINIMAP ")!.ids).toEqual(new Set(["minimap"]));
  });

  it("does not answer a section or tab title, which has no row to count", () => {
    // `matchingSections` matches titles; this does not, deliberately. A badge on
    // "Appearance" with nothing highlighted underneath is a count the user
    // cannot check against what they see.
    expect(matchingEntries("Typography")!.total).toBe(0);
  });
});
