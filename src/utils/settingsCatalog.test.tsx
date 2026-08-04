// `.tsx` with no JSX in it: the extension is what puts a file in the jsdom
// project (see vitest.config.ts), and reading `DEFAULT_SETTINGS` reaches the
// theme module at import time, which needs a document.
//
// The catalogue is the one place a setting is named, so what is worth asserting
// about it is coverage: a key added to `EditorDefaults` and wired to a feature
// but never listed here is invisible in the panel, in the filter box, and in the
// palette at once, and works only for someone who hand-edits settings.json.
import { describe, it, expect } from "vitest";
import { SECTION_TITLES, SETTINGS, type SettingSection } from "./settingsCatalog";
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
    const declared = Object.keys(DEFAULT_SETTINGS.editorDefaults).sort();
    const listed = SETTINGS.filter((s) => s.toggles).map((s) => s.toggles!);
    expect([...listed].sort()).toEqual(declared);
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
