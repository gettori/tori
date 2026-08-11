// The Settings panel's filter box: which sections a query leaves on screen.
//
// Section granularity is the contract, not an implementation detail. A query
// that matches one row keeps that row's neighbours, because a setting is read
// through the ones around it.
import { describe, it, expect } from "vitest";
import { matchingEntries, matchingSections } from "./settingsSearch";
import { SETTINGS, SETTING_TABS, TAB_OF_SECTION } from "../../utils/settingsCatalog";

describe("filtering the settings panel", () => {
  it("shows everything when nothing is typed", () => {
    // `null`, not a full set: the caller has to tell "nothing typed" from
    // "nothing matched", and only one of those says so on screen.
    expect(matchingSections("")).toBeNull();
    expect(matchingSections("   ")).toBeNull();
  });

  it("finds a setting by a fragment of its name", () => {
    expect(matchingSections("minimap")).toEqual(new Set(["editing"]));
  });

  it("matches a label loosely, the way the palette does", () => {
    // "sfw" for "Soft wrap long lines". The looseness earns its keep on a short
    // label, which is why it is only applied to one.
    expect(matchingSections("sfw")?.has("editing")).toBe(true);
  });

  it("finds a section by its own title", () => {
    expect(matchingSections("Typography")).toEqual(new Set(["typography"]));
  });

  it("quotes a hint rather than guessing at it", () => {
    // A hint is prose, and almost any query is a *subsequence* of a hundred
    // characters of it. Matched as a substring the phrase still finds its
    // section; matched loosely, every section would answer every query.
    expect(matchingSections("Prettier")).toEqual(new Set(["editor"]));
    expect(matchingSections("ptr")?.has("editor")).toBe(false);
  });

  it("keeps a matching row's neighbours", () => {
    // The whole section, not the one row: "Stop at context" is understood next
    // to the two dollar ceilings above it.
    const chat = matchingSections("Stop at context");
    expect(chat).toEqual(new Set(["chat"]));
  });

  it("reaches the sections whose rows only exist at runtime", () => {
    // Agents, language servers and GitHub render their own controls, so the
    // catalogue carries one entry each standing for the section. Without it they
    // would be the three the filter could never find.
    // Not an exact set: Harness answers "Agents" too, because its hint sends you
    // there. A section that names another is a section worth showing.
    expect(matchingSections("Agents")?.has("agents")).toBe(true);
    expect(matchingSections("language server")?.has("lsp")).toBe(true);
    expect(matchingSections("GitHub")).toEqual(new Set(["github"]));
  });

  it("answers an empty set for a query nothing matches", () => {
    expect(matchingSections("zzzqqq")).toEqual(new Set());
  });

  it("ignores case and surrounding space", () => {
    expect(matchingSections("  MINIMAP ")).toEqual(new Set(["editing"]));
  });
});

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
