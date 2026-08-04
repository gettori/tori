import { describe, it, expect } from "vitest";
import configSource from "../../../src-tauri/src/config.rs?raw";
import { editorOrigins, overlayFile, parseOverlay, resolveEditorDefaults, withOverride } from "./workspaceSettings";
import type { EditorDefaults } from "./settingsStore";

/** The default layer, spelled out so a test says which value it is asserting
 *  about rather than inheriting whatever the shipped defaults are today. */
const DEFAULTS: EditorDefaults = {
  formatOnSave: false,
  vimMode: false,
  indentGuides: true,
  softWrap: false,
  renderWhitespace: false,
  scrollPastEnd: true,
  rainbowBrackets: false,
  bracketPairGuides: false,
  minimap: false,
  wordCompletion: true,
  hotExit: true,
  compactFolders: true,
};

describe("which layer wins", () => {
  it("falls all the way through to the default when nobody has an opinion", () => {
    expect(resolveEditorDefaults(DEFAULTS, DEFAULTS, {})).toEqual(DEFAULTS);
  });

  it("lets the user beat the default", () => {
    const user = { ...DEFAULTS, minimap: true };
    expect(resolveEditorDefaults(DEFAULTS, user, {}).minimap).toBe(true);
  });

  it("lets the workspace beat the user", () => {
    const user = { ...DEFAULTS, minimap: true };
    expect(resolveEditorDefaults(DEFAULTS, user, { minimap: false }).minimap).toBe(false);
  });

  // The distinction the whole overlay rests on: absent is "no answer here",
  // which is not the same claim as an explicit `false`.
  it("takes an explicit false as an answer, not as an absence", () => {
    const user = { ...DEFAULTS, compactFolders: true };
    expect(resolveEditorDefaults(DEFAULTS, user, { compactFolders: false }).compactFolders).toBe(false);
    expect(resolveEditorDefaults(DEFAULTS, user, {}).compactFolders).toBe(true);
  });

  it("leaves every other setting alone when one is overridden", () => {
    const resolved = resolveEditorDefaults(DEFAULTS, DEFAULTS, { minimap: true });
    expect(resolved).toEqual({ ...DEFAULTS, minimap: true });
  });
});

describe("reading an overlay file", () => {
  it("takes the keys it knows", () => {
    expect(parseOverlay({ editor: { compactFolders: false, minimap: true } }, DEFAULTS)).toEqual({
      compactFolders: false,
      minimap: true,
    });
  });

  it("reads a missing overlay as no overrides rather than an error", () => {
    for (const raw of [null, undefined, {}, { editor: null }, { editor: [] }, "nonsense", 7]) {
      expect(parseOverlay(raw, DEFAULTS)).toEqual({});
    }
  });

  // A hand-edited file, or one written by a newer build: the keys it does not
  // recognise must not reach a resolver that would hand them to CodeMirror.
  it("drops a key it does not know and a value of the wrong type", () => {
    const raw = { editor: { minimap: true, notASetting: true, compactFolders: "yes" } };
    expect(parseOverlay(raw, DEFAULTS)).toEqual({ minimap: true });
  });

  it("round-trips through the shape the file holds", () => {
    const overlay = { minimap: true };
    expect(parseOverlay(overlayFile(overlay), DEFAULTS)).toEqual(overlay);
  });
});

describe("where a value came from", () => {
  it("says default when nobody has touched it", () => {
    expect(editorOrigins(DEFAULTS, DEFAULTS, {}).minimap).toBe("default");
  });

  it("says user when the settings file differs from the default", () => {
    expect(editorOrigins(DEFAULTS, { ...DEFAULTS, minimap: true }, {}).minimap).toBe("user");
  });

  // The badge's one hard promise.
  it("says workspace only when the overlay supplies the value", () => {
    const user = { ...DEFAULTS, minimap: true };
    const origins = editorOrigins(DEFAULTS, user, { compactFolders: false });
    expect(origins.compactFolders).toBe("workspace");
    expect(origins.minimap).toBe("user");
    expect(origins.softWrap).toBe("default");
  });

  // Presence, not value: an overlay agreeing with the layer below it is still
  // the overlay's answer, and clearing it would change nothing today but is a
  // different statement about tomorrow.
  it("says workspace even when the overlay agrees with what was already in force", () => {
    expect(editorOrigins(DEFAULTS, DEFAULTS, { minimap: false }).minimap).toBe("workspace");
  });

  it("has an answer for every setting", () => {
    const origins = editorOrigins(DEFAULTS, DEFAULTS, {});
    expect(Object.keys(origins).sort()).toEqual(Object.keys(DEFAULTS).sort());
  });
});

// The overlay supersedes `adr_ui_config_system`'s "global-only, no per-project
// override" clause, and this is the guard that keeps the supersession narrow:
// preferences live in JSONC, `sway.toml` stays project *discovery* config. A
// second place to configure editor behaviour is the failure mode the ADR's split
// exists to prevent, and it would arrive one key at a time.
it("leaves sway.toml out of editor behaviour, so there is only one place to set it", () => {
  const spellings = Object.keys(DEFAULTS).flatMap((key) => [
    key,
    key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
  ]);
  const found = spellings.filter((s) => new RegExp(`\\b${s}\\b`).test(configSource));
  expect(found).toEqual([]);
});

describe("changing a workspace answer", () => {
  it("records one", () => {
    expect(withOverride({}, "minimap", true)).toEqual({ minimap: true });
  });

  it("hands a setting back to the layer below rather than pinning it", () => {
    // Clearing, not setting-to-the-inherited-value: the two look the same today
    // and differ the moment the user changes their global preference.
    expect(withOverride({ minimap: true }, "minimap", undefined)).toEqual({});
  });

  it("leaves the other answers alone", () => {
    expect(withOverride({ minimap: true }, "compactFolders", false)).toEqual({
      minimap: true,
      compactFolders: false,
    });
  });

  it("does not mutate what it was given", () => {
    const overlay = { minimap: true };
    withOverride(overlay, "minimap", undefined);
    expect(overlay).toEqual({ minimap: true });
  });
});
