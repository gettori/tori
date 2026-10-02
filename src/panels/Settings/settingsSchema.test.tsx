// The schema is the fourth home of an `EditorDefaults` key, after the type,
// `settingsCatalog`, and `settings.rs`'s struct. Each of the other three has a
// test that fails when a key is added to the type and not to it; this is that
// test for the schema.
//
// It fails *after* `settingsCatalog.test.tsx` does, by design: the key list
// comes from `DEFAULT_SETTINGS.editorDefaults`, which is the type made
// runtime-visible, so adding a key to the type breaks the catalog test first
// and this one second. Both name the file to edit.

import { describe, it, expect } from "vitest";
import userRaw from "../../../src-tauri/resources/schemas/tori-settings.schema.json?raw";
import workspaceRaw from "../../../src-tauri/resources/schemas/tori-workspace-settings.schema.json?raw";
import { SETTINGS } from "../../utils/settingsCatalog";
import { TORI_SETTINGS_FILES } from "../../utils/toriSettingsFiles";
import { DEFAULT_SETTINGS } from "./settingsStore";

const USER_FILE = "src-tauri/resources/schemas/tori-settings.schema.json";
const WORKSPACE_FILE = "src-tauri/resources/schemas/tori-workspace-settings.schema.json";

type Block = {
  type: string;
  additionalProperties?: boolean;
  properties: Record<string, { type: string; description?: string; default?: unknown }>;
};
type Schema = {
  type: string;
  additionalProperties?: boolean;
  properties: Record<string, Block>;
};

// Parsed here rather than imported as JSON so a file that stopped being valid
// JSON fails this suite loudly, instead of reaching the server that would then
// quietly validate nothing against it.
const user = JSON.parse(userRaw) as Schema;
const workspace = JSON.parse(workspaceRaw) as Schema;

const defaults = DEFAULT_SETTINGS.editorDefaults as unknown as Record<string, unknown>;

/** The catalog's name for a setting, which is what the panel calls it. */
function labelOf(key: string): string {
  const entry = SETTINGS.find((s) => s.toggles === key || s.edits === key);
  return entry?.label ?? "";
}

describe("the shipped settings schemas", () => {
  it("describe every editor default and nothing else", () => {
    // The one that fails when a setting is added to the type and stops there.
    const declared = Object.keys(defaults).sort();
    for (const [file, block] of [
      [USER_FILE, user.properties.editorDefaults],
      [WORKSPACE_FILE, workspace.properties.editor],
    ] as const) {
      expect(Object.keys(block.properties).sort(), `add the new key to ${file}`).toEqual(declared);
    }
  });

  it("give each key the type and the default it actually ships with", () => {
    const block = user.properties.editorDefaults;
    for (const [key, value] of Object.entries(defaults)) {
      expect(block.properties[key].type, `${key} in ${USER_FILE}`).toBe(typeof value);
      expect(block.properties[key].default, `${key} in ${USER_FILE}`).toEqual(value);
    }
  });

  it("describe each key, leading with the name the panel gives it", () => {
    // The hover text is the whole reason a schema is worth shipping, and a
    // description is the one part no type checker can notice is missing or
    // attached to the wrong key. Leading with the panel's label is what ties
    // the two surfaces to the same setting.
    const block = user.properties.editorDefaults;
    for (const key of Object.keys(defaults)) {
      const label = labelOf(key);
      // Asserted first, because every check below is vacuous without it: an
      // empty label makes `startsWith` trivially true, so a key that fell out
      // of the catalog would leave this test passing while checking nothing.
      expect(label, `${key} has no label in settingsCatalog`).not.toBe("");
      const description = block.properties[key].description ?? "";
      expect(description.startsWith(label), `${key}: "${description}" should lead with "${label}"`).toBe(true);
      expect(description.length, `${key} in ${USER_FILE}`).toBeGreaterThan(label.length);
    }
  });

  it("keep the two copies of the editor block identical", () => {
    // The two files exist because `editor` means different things in each, not
    // because the block does. Nothing enforces that at the type level, so this
    // is what makes them one home rather than two.
    expect(workspace.properties.editor).toEqual(user.properties.editorDefaults);
  });

  it("flag a key that is not a setting", () => {
    // `additionalProperties: false` is the whole of "an unknown key is
    // flagged", and both the overlay parser and serde drop such a key, so
    // saying so is accurate rather than merely strict.
    expect(user.properties.editorDefaults.additionalProperties, USER_FILE).toBe(false);
    expect(workspace.properties.editor.additionalProperties, WORKSPACE_FILE).toBe(false);
  });

  it("constrain the workspace file completely and the global file only where it knows the shape", () => {
    // A workspace overlay holds the editor, lsp and format blocks and nothing
    // else, so anything else in it is read by nothing and worth saying so. The global file also
    // holds appearance, typography, chat and the rest, none of which this
    // schema models - closing it would report a newer build's own keys as
    // errors in a file that build had just written.
    expect(workspace.additionalProperties, WORKSPACE_FILE).toBe(false);
    expect(Object.keys(workspace.properties), WORKSPACE_FILE).toEqual(["editor", "lsp", "format"]);
    expect(user.additionalProperties, USER_FILE).toBeUndefined();
    // Which is what makes a section this schema has never heard of valid
    // rather than flagged. `agent.defaultProfiles` (which account a new
    // session starts on) is the newest of them: the Settings panel writes it,
    // so it is described where the panel is, not here. Modelling half the
    // `agent` block would report the other half as errors.
    expect(Object.keys(user.properties), USER_FILE).toEqual(["editorDefaults", "lsp", "dap", "format"]);
  });

  it("are the files the associations point at", () => {
    // A schema shipped under a name nothing asks for is a schema that never
    // loads, and the server reports no error for an association it cannot read.
    expect(TORI_SETTINGS_FILES.map((f) => f.schema).sort()).toEqual([
      "tori-settings.schema.json",
      "tori-workspace-settings.schema.json",
    ]);
  });
});
