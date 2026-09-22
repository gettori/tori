import { describe, it, expect } from "vitest";
import configSource from "../../../../src-tauri/src/config.rs?raw";
import settingsSource from "../../../../src-tauri/src/settings.rs?raw";
import { editorOrigins, overlayFile, parseOverlay, resolveEditorDefaults, withOverride } from "./workspaceSettings";
import type { ChatDefaults, EditorDefaults } from "../settingsStore";

/** The default layer, spelled out so a test says which value it is asserting
 *  about rather than inheriting whatever the shipped defaults are today. */
const DEFAULTS: EditorDefaults = {
  formatOnSave: false,
  organizeImportsOnSave: false,
  codeActionsOnSave: false,
  codeLens: false,
  trimTrailingWhitespace: false,
  insertFinalNewline: false,
  vimMode: false,
  tabSize: 2,
  insertSpaces: true,
  indentGuides: true,
  activeLineHighlight: "all",
  softWrap: false,
  renderWhitespace: false,
  scrollPastEnd: true,
  rainbowBrackets: false,
  bracketPairGuides: false,
  minimap: false,
  stickyScroll: false,
  wordCompletion: true,
  hotExit: true,
  compactFolders: true,
  todoPatterns: "TODO,FIXME,HACK,XXX",
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

  // Named rather than left to the generic cases above, because the rule this
  // phase was handed was "register the setting here and the layers come free",
  // and a rule is worth one test that says the name out loud.
  it("gives sticky scroll the same three layers, off by default", () => {
    expect(DEFAULTS.stickyScroll).toBe(false);
    const user = { ...DEFAULTS, stickyScroll: true };
    expect(resolveEditorDefaults(DEFAULTS, user, {}).stickyScroll).toBe(true);
    expect(resolveEditorDefaults(DEFAULTS, user, { stickyScroll: false }).stickyScroll).toBe(false);
    expect(editorOrigins(DEFAULTS, user, { stickyScroll: false }).stickyScroll).toBe("workspace");
  });

  // The first setting here that is not a switch, and the reason it is a string
  // rather than a list of tags: every rule in this module is written against
  // `typeof` and `!==`, and both are exact for a string. On an array the
  // validator would admit anything object-shaped and the origin badge would
  // call every workspace value an override, because no two arrays are equal.
  it("gives the TODO tags the same three layers", () => {
    const user = { ...DEFAULTS, todoPatterns: "TODO,FIXME" };
    expect(resolveEditorDefaults(DEFAULTS, user, {}).todoPatterns).toBe("TODO,FIXME");
    // A repo that calls them something else says so, and wins.
    expect(resolveEditorDefaults(DEFAULTS, user, { todoPatterns: "REVIEW" }).todoPatterns).toBe(
      "REVIEW",
    );
    expect(editorOrigins(DEFAULTS, user, { todoPatterns: "REVIEW" }).todoPatterns).toBe("workspace");
    expect(editorOrigins(DEFAULTS, user, {}).todoPatterns).toBe("user");
  });

  it("takes an empty tag list from a workspace as an answer, not an absence", () => {
    // A repo that wants no TODO panel at all can say so, and it must not read
    // as "no opinion" and fall through to the user's tags.
    const user = { ...DEFAULTS, todoPatterns: "TODO" };
    expect(resolveEditorDefaults(DEFAULTS, user, { todoPatterns: "" }).todoPatterns).toBe("");
    expect(resolveEditorDefaults(DEFAULTS, user, {}).todoPatterns).toBe("TODO");
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

  // The type check runs off the default's own type, so it admits a string where
  // the default is a string and refuses one where the default is a boolean.
  it("takes a string setting as a string and refuses anything else", () => {
    expect(parseOverlay({ editor: { todoPatterns: "REVIEW,NOTE" } }, DEFAULTS)).toEqual({
      todoPatterns: "REVIEW,NOTE",
    });
    for (const bad of [true, 7, ["TODO"], null, {}]) {
      expect(parseOverlay({ editor: { todoPatterns: bad } }, DEFAULTS), `${JSON.stringify(bad)}`).toEqual({});
    }
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
// preferences live in JSONC, `tori.toml` stays project *discovery* config. A
// second place to configure editor behaviour is the failure mode the ADR's split
// exists to prevent, and it would arrive one key at a time.
it("leaves tori.toml out of editor behaviour, so there is only one place to set it", () => {
  const spellings = Object.keys(DEFAULTS).flatMap((key) => [
    key,
    key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
  ]);
  const found = spellings.filter((s) => new RegExp(`\\b${s}\\b`).test(configSource));
  expect(found).toEqual([]);
});

// The mirror of the guard above, and the one that was missing. `set_settings`
// takes a *typed* struct, so a key the frontend has and the struct does not is
// dropped by serde on the way in and written back out gone: the preference
// cannot be saved, and it snaps back to its default on the next round trip.
// `compactFolders` shipped that way and nothing said so.
//
// `chatDefaults` joined the sweep when the concurrency cap was added: the guard
// covered `editorDefaults` alone, so the section that had grown the most keys
// since was the one nothing was checking.
describe("every frontend setting has a field in the struct that persists it", () => {
  // Spelled out and *typed*, not read off the live defaults: the annotation is
  // half the guard. A key added to the type without being added here fails to
  // compile, which is what stops the sweep quietly shrinking to the keys that
  // happened to exist when it was written. (The store cannot be imported for
  // its value here either - it reads `localStorage` at module load and this
  // file runs without a DOM.)
  const CHAT: ChatDefaults = {
    defaultSurface: "chat",
    model: null,
    effort: null,
    mode: null,
    streaming: true,
    density: "comfortable",
    toolOutputLines: 20,
    showToriHooks: false,
    answerQuestionsInline: true,
    attachLongPastes: true,
    maxConcurrentChats: 4,
  };
  const sections: Record<string, object> = { editorDefaults: DEFAULTS, chatDefaults: CHAT };
  for (const [section, shape] of Object.entries(sections)) {
    it(section, () => {
      const missing = Object.keys(shape).filter(
        (key) => !new RegExp(`\\b${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}\\b`).test(settingsSource),
      );
      expect(missing).toEqual([]);
    });
  }
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
