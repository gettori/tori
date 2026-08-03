import { describe, it, expect, vi, beforeEach } from "vitest";

// `.tsx`, with no JSX in it: the extension is what puts a file in the jsdom
// project (see vitest.config.ts), and the store reaches the theme module at
// import time, which needs a document. Renaming this to `.test.ts` would run it
// in node and fail on the import rather than on anything it asserts.
//
// The two editor settings resolve differently on purpose, and that difference
// is most of what is asserted here.
//
// Format-on-save has three answers, not two, because which formatter runs is a
// property of the repo:
//
//   * this project has never been asked  -> the global default decides
//   * this project said yes / said no    -> it decides, whatever the default is
//
// A resolution written with `||` instead of `??` would collapse the second into
// the first and quietly reformat a repo that had opted out.
//
// Vim mode has one answer for everything, because whether `hjkl` moves the
// caret is a property of the person, not of the repo.

let saved: unknown = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "set_settings") {
      saved = args!.settings;
      return Promise.resolve(saved);
    }
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const {
  DEFAULT_SETTINGS,
  saveSettings,
  formatOnSaveFor,
  vimModeOn,
  toggleVimMode,
  rememberFormatOnSave,
  settings,
} = await import("./settingsStore");

/** Seed the store through the real save path, which is the only way in.
 *
 *  The editor fields are restated rather than taken from
 *  `DEFAULT_SETTINGS`: the store is created *over* that object, so writing to
 *  the store mutates it in place and the "defaults" a later test reads back are
 *  whatever the previous one saved. `ReviewPanel.test.tsx` documents the same
 *  trap. */
async function seed(patch: Partial<typeof DEFAULT_SETTINGS>) {
  await saveSettings({
    ...structuredClone(DEFAULT_SETTINGS),
    editorDefaults: { formatOnSave: false, vimMode: false },
    editor: {},
    ...patch,
  });
}

beforeEach(async () => {
  saved = null;
  await seed({});
});

describe("formatOnSaveFor", () => {
  it("is off when nothing has been chosen", async () => {
    // That off is the *shipped* default is asserted on the Rust side, where the
    // settings file is read: `settings.rs` owns the value, and this store only
    // holds a placeholder until the file arrives.
    expect(formatOnSaveFor("/repo")).toBe(false);
    expect(formatOnSaveFor(null)).toBe(false);
  });

  it("follows the global default for a project that has never been asked", async () => {
    await seed({ editorDefaults: { formatOnSave: true, vimMode: false } });
    expect(formatOnSaveFor("/repo/never-asked")).toBe(true);
  });

  it("lets a project opt out of a default that is on", async () => {
    await seed({
      editorDefaults: { formatOnSave: true, vimMode: false },
      editor: { "/repo/legacy": { formatOnSave: false } },
    });
    expect(formatOnSaveFor("/repo/legacy")).toBe(false);
    expect(formatOnSaveFor("/repo/other")).toBe(true);
  });

  it("lets a project opt in when the default is off", async () => {
    await seed({ editor: { "/repo/tidy": { formatOnSave: true } } });
    expect(formatOnSaveFor("/repo/tidy")).toBe(true);
    expect(formatOnSaveFor("/repo/other")).toBe(false);
  });

  it("treats a null entry as no answer rather than as no", async () => {
    // What clearing a project's choice writes. It has to fall back to the
    // default, not pin the project to off.
    await seed({
      editorDefaults: { formatOnSave: true, vimMode: false },
      editor: { "/repo/cleared": { formatOnSave: null } },
    });
    expect(formatOnSaveFor("/repo/cleared")).toBe(true);
  });

  it("has only the default to go on with no project selected", async () => {
    await seed({ editorDefaults: { formatOnSave: true, vimMode: false } });
    expect(formatOnSaveFor(null)).toBe(true);
  });
});

describe("rememberFormatOnSave", () => {
  it("records one project's answer without touching another's", async () => {
    await seed({ editor: { "/repo/a": { formatOnSave: true } } });
    rememberFormatOnSave("/repo/b", false);
    await vi.waitFor(() => expect(settings.editor["/repo/b"]).toBeTruthy());
    expect(settings.editor["/repo/a"].formatOnSave).toBe(true);
    expect(settings.editor["/repo/b"].formatOnSave).toBe(false);
  });

  it("clears an answer back to the default", async () => {
    await seed({ editorDefaults: { formatOnSave: true, vimMode: false }, editor: { "/repo/a": { formatOnSave: false } } });
    rememberFormatOnSave("/repo/a", null);
    await vi.waitFor(() => expect(formatOnSaveFor("/repo/a")).toBe(true));
  });
});

describe("vimModeOn", () => {
  it("is off until it is turned on", async () => {
    await seed({});
    expect(vimModeOn()).toBe(false);
    await seed({ editorDefaults: { formatOnSave: false, vimMode: true } });
    expect(vimModeOn()).toBe(true);
  });

  it("flips and remembers", async () => {
    // The palette's toggle goes through here rather than through Settings.tsx,
    // which is not necessarily open when it fires.
    await seed({});
    toggleVimMode();
    await vi.waitFor(() => expect(vimModeOn()).toBe(true));
    toggleVimMode();
    await vi.waitFor(() => expect(vimModeOn()).toBe(false));
  });

  it("leaves format-on-save where it was", async () => {
    // The two share `editorDefaults`, so a toggle that rebuilt the object
    // instead of spreading it would silently switch formatting off.
    await seed({ editorDefaults: { formatOnSave: true, vimMode: false } });
    toggleVimMode();
    await vi.waitFor(() => expect(vimModeOn()).toBe(true));
    expect(formatOnSaveFor(null)).toBe(true);
  });

  it("answers the same for every project", async () => {
    // Deliberately not per-project, and this is the assertion that says so:
    // which formatter runs is the repo's business, but whether `hjkl` moves the
    // caret is the person's, and a per-project answer would mean the same hands
    // typing differently in two windows of the same editor.
    await seed({
      editorDefaults: { formatOnSave: false, vimMode: true },
      editor: { "/repo/a": { formatOnSave: false } },
    });
    expect(vimModeOn()).toBe(true);
    expect(formatOnSaveFor("/repo/a")).toBe(false);
  });
});
