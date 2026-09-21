// `.tsx` with no JSX in it: the extension is what puts a file in the jsdom
// project (see vitest.config.ts), and reading `DEFAULT_SETTINGS` reaches the
// theme module at import time, which needs a document.
//
// The catalogue is the one place a setting is named, so what is worth asserting
// about it is coverage: a key added to `EditorDefaults` and wired to a feature
// but never listed here is invisible in the panel, in the filter box, and in the
// palette at once, and works only for someone who hand-edits settings.json.
import { describe, it, expect } from "vitest";
import {
  SECTION_TITLES,
  SETTINGS,
  SETTING_TABS,
  TAB_OF_SECTION,
  type SettingSection,
} from "./settingsCatalog";
import { DEFAULT_SETTINGS, type EditorDefaults } from "../panels/Settings/settingsStore";

describe("the settings catalogue", () => {
  it("has a unique id per setting", () => {
    const ids = SETTINGS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names a section that exists, for every entry", () => {
    for (const s of SETTINGS) {
      expect(SECTION_TITLES[s.section], `${s.id} sits in an unnamed section`).toBeTruthy();
    }
  });

  it("gives every section at least one entry to be found by", () => {
    // A section with no entry is reachable only by its own title, and a title is
    // the thing a user is least likely to type.
    const covered = new Set(SETTINGS.map((s) => s.section));
    for (const section of Object.keys(SECTION_TITLES) as SettingSection[]) {
      expect(covered.has(section), `${section} has no setting listed under it`).toBe(true);
    }
  });

  it("lists every editor default exactly once", () => {
    // The rule Phase 4 recorded, checked rather than remembered: a setting is
    // registered in `EditorDefaults` and read through the layer resolution, and
    // this is what fails when the second half of that is skipped.
    //
    // Two fields, because not every setting the resolution answers for is a
    // switch: `toggles` for the booleans a command can flip, `edits` for the
    // ones that get a row and no command. Both count as registered; what must
    // never happen is a key in the type that appears in neither.
    const declared = Object.keys(DEFAULT_SETTINGS.editorDefaults).sort();
    const listed = SETTINGS.flatMap((s) => [s.toggles, s.edits]).filter(Boolean) as string[];
    expect([...listed].sort()).toEqual(declared);
  });

  it("never marks one setting as both a toggle and a row of its own", () => {
    // They are alternatives, not layers: a key claiming both would be drawn
    // twice and flipped by a command that its own row cannot show.
    for (const s of SETTINGS) {
      expect(!(s.toggles && s.edits), `${s.id} claims both`).toBe(true);
    }
  });

  it("puts every editor default in a section the panel renders as toggles", () => {
    // The two Editor sections, and only those: a boolean landing anywhere else
    // would be listed by the catalogue and drawn by nothing.
    const toggleSections: SettingSection[] = ["editor", "editing"];
    for (const s of SETTINGS.filter((s) => s.toggles)) {
      expect(toggleSections, `${s.id} is a toggle outside the Editor sections`).toContain(s.section);
    }
  });

  it("marks as a toggle only what the layer resolution answers for", () => {
    // A chat or budget boolean is a boolean too, but it has no workspace layer,
    // so a command that flipped it would be writing somewhere the panel's badge
    // cannot explain. Those open the panel instead.
    const editorKeys = new Set(Object.keys(DEFAULT_SETTINGS.editorDefaults));
    for (const s of SETTINGS.filter((s) => s.toggles)) {
      expect(editorKeys.has(s.toggles as keyof EditorDefaults), `${s.id}`).toBe(true);
    }
  });
});

describe("the tab grouping", () => {
  it("shows every section in exactly one tab", () => {
    // The grouping is a layer over the sections, so it has to be total and
    // disjoint: a section in no tab is a set of settings nothing renders, and a
    // section in two is a row the user finds twice and a search count that
    // double-counts it.
    const placed = SETTING_TABS.flatMap((t) => t.sections);
    expect([...placed].sort()).toEqual((Object.keys(SECTION_TITLES) as SettingSection[]).sort());
    expect(new Set(placed).size, "a section is listed under two tabs").toBe(placed.length);
  });

  it("keeps the strip order pinned", () => {
    // A fixture rather than a rule, because the order is a judgement about what
    // a user reaches for first and nothing derives it. Changing it is allowed;
    // changing it by accident is what this catches.
    expect(SETTING_TABS.map((t) => t.id)).toEqual([
      "agents",
      "chat",
      "editor",
      "panes",
      "servers",
      "debuggers",
      "linters",
      "formatters",
      "projects",
      "appearance",
      "integrations",
      "advanced",
    ]);
    expect(SETTING_TABS.map((t) => t.sections)).toEqual([
      ["agents"],
      ["chat", "checkpoints"],
      ["editor", "editing"],
      ["panes"],
      ["lsp"],
      ["dap"],
      ["lint"],
      ["fmt"],
      ["trust"],
      ["appearance", "typography"],
      ["git", "forge"],
      ["root", "danger"],
    ]);
  });

  it("gives every tab a unique id, a label and an icon", () => {
    const ids = SETTING_TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of SETTING_TABS) {
      expect(t.label, `${t.id} has no label`).toBeTruthy();
      // A lucide id, kebab-case: the panel looks the component up by this name,
      // so a stray `Bot` or empty string is a tab that renders without a glyph.
      expect(t.icon, `${t.id}'s icon is not a kebab-case lucide id`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("derives the section-to-tab map from the tabs themselves", () => {
    for (const t of SETTING_TABS) {
      for (const s of t.sections) expect(TAB_OF_SECTION[s]).toBe(t.id);
    }
    expect(Object.keys(TAB_OF_SECTION).sort()).toEqual(Object.keys(SECTION_TITLES).sort());
  });
});
