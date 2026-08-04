// The Settings panel's filter box: which sections a query leaves on screen.
//
// Section granularity is the contract, not an implementation detail. A query
// that matches one row keeps that row's neighbours, because a setting is read
// through the ones around it.
import { describe, it, expect } from "vitest";
import { matchingSections } from "./settingsSearch";

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
