import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

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

let wsWrites: { root: string; settings: unknown }[] = [];
let wsOverlay: Record<string, unknown> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "set_settings") {
      saved = args!.settings;
      return Promise.resolve(saved);
    }
    if (cmd === "get_workspace_settings") return Promise.resolve({ editor: wsOverlay });
    if (cmd === "set_workspace_settings") {
      wsWrites.push(args as { root: string; settings: unknown });
      return Promise.resolve(args!.settings);
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
  toggleEditorDefault,
  rememberFormatOnSave,
  settings,
  loadWorkspaceSettings,
  editorDefaults,
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
    editorDefaults: { ...DEFAULT_SETTINGS.editorDefaults, formatOnSave: false, vimMode: false },
    editor: {},
    ...patch,
  });
}

beforeEach(async () => {
  saved = null;
  wsWrites = [];
  wsOverlay = {};
  // The overlay outlives any one test, so a workspace selected by one would
  // otherwise still be answering for the next.
  await loadWorkspaceSettings(null);
  await seed({});
});

/** Select a workspace whose overlay holds these answers. */
async function useWorkspace(root: string, overlay: Record<string, unknown>) {
  wsOverlay = overlay;
  await loadWorkspaceSettings(root);
}

describe("formatOnSaveFor", () => {
  it("is off when nothing has been chosen", async () => {
    // That off is the *shipped* default is asserted on the Rust side, where the
    // settings file is read: `settings.rs` owns the value, and this store only
    // holds a placeholder until the file arrives.
    expect(formatOnSaveFor("/repo")).toBe(false);
    expect(formatOnSaveFor(null)).toBe(false);
  });

  it("follows the global default for a project that has never been asked", async () => {
    await seed({ editorDefaults: { ...DEFAULT_SETTINGS.editorDefaults, formatOnSave: true, vimMode: false } });
    expect(formatOnSaveFor("/repo/never-asked")).toBe(true);
  });

  it("lets a project opt out of a default that is on", async () => {
    await seed({
      editorDefaults: { ...DEFAULT_SETTINGS.editorDefaults, formatOnSave: true, vimMode: false },
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
      editorDefaults: { ...DEFAULT_SETTINGS.editorDefaults, formatOnSave: true, vimMode: false },
      editor: { "/repo/cleared": { formatOnSave: null } },
    });
    expect(formatOnSaveFor("/repo/cleared")).toBe(true);
  });

  it("has only the default to go on with no project selected", async () => {
    await seed({ editorDefaults: { ...DEFAULT_SETTINGS.editorDefaults, formatOnSave: true, vimMode: false } });
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
    await seed({
      editorDefaults: { ...DEFAULT_SETTINGS.editorDefaults, formatOnSave: true, vimMode: false },
      editor: { "/repo/a": { formatOnSave: false } },
    });
    rememberFormatOnSave("/repo/a", null);
    await vi.waitFor(() => expect(formatOnSaveFor("/repo/a")).toBe(true));
  });
});

describe("vimModeOn", () => {
  it("is off until it is turned on", async () => {
    await seed({});
    expect(vimModeOn()).toBe(false);
    await seed({ editorDefaults: { ...DEFAULT_SETTINGS.editorDefaults, formatOnSave: false, vimMode: true } });
    expect(vimModeOn()).toBe(true);
  });

  it("flips and remembers", async () => {
    // The palette's toggle goes through here rather than through Settings.tsx,
    // which is not necessarily open when it fires.
    await seed({});
    toggleEditorDefault("vimMode");
    await vi.waitFor(() => expect(vimModeOn()).toBe(true));
    toggleEditorDefault("vimMode");
    await vi.waitFor(() => expect(vimModeOn()).toBe(false));
  });

  it("leaves format-on-save where it was", async () => {
    // The two share `editorDefaults`, so a toggle that rebuilt the object
    // instead of spreading it would silently switch formatting off.
    await seed({ editorDefaults: { ...DEFAULT_SETTINGS.editorDefaults, formatOnSave: true, vimMode: false } });
    toggleEditorDefault("vimMode");
    await vi.waitFor(() => expect(vimModeOn()).toBe(true));
    expect(formatOnSaveFor(null)).toBe(true);
  });

  it("answers the same for every project", async () => {
    // Deliberately not per-project, and this is the assertion that says so:
    // which formatter runs is the repo's business, but whether `hjkl` moves the
    // caret is the person's, and a per-project answer would mean the same hands
    // typing differently in two windows of the same editor.
    await seed({
      editorDefaults: { ...DEFAULT_SETTINGS.editorDefaults, formatOnSave: false, vimMode: true },
      editor: { "/repo/a": { formatOnSave: false } },
    });
    expect(vimModeOn()).toBe(true);
    expect(formatOnSaveFor("/repo/a")).toBe(false);
  });
});

describe("the layer a write lands in", () => {
  // Always writing the global layer would make this key look dead wherever a
  // workspace overrides it: the flip lands underneath the overlay, the overlay
  // keeps winning, and the shortcut does nothing however often it is pressed.
  it("flips vim mode in the workspace's overlay when that is what is in force", async () => {
    await seed({ editorDefaults: { ...DEFAULT_SETTINGS.editorDefaults, formatOnSave: false, vimMode: true } });
    await useWorkspace("/repo/a", { vimMode: false });
    expect(vimModeOn()).toBe(false);
    saved = null;

    toggleEditorDefault("vimMode");

    await vi.waitFor(() => expect(vimModeOn()).toBe(true));
    expect(wsWrites).toEqual([{ root: "/repo/a", settings: { editor: { vimMode: true } } }]);
    // And the global answer is left exactly where it was.
    expect(saved).toBeNull();
  });

  it("still flips the global answer where no workspace has one", async () => {
    await useWorkspace("/repo/a", {});
    toggleEditorDefault("vimMode");
    await vi.waitFor(() => expect(vimModeOn()).toBe(true));
    expect(wsWrites).toEqual([]);
    expect(saved).not.toBeNull();
  });
});

describe("which workspace an overlay answers for", () => {
  // The overlay is loaded for one workspace. A function handed an explicit path
  // must not borrow it: that would report a different project's settings under
  // the name of the one that was asked about.
  it("does not lend one workspace's answers to another project", async () => {
    await seed({ editorDefaults: { ...DEFAULT_SETTINGS.editorDefaults, formatOnSave: true, vimMode: false } });
    await useWorkspace("/repo/a", { formatOnSave: false });

    expect(formatOnSaveFor("/repo/a")).toBe(false);
    // A different project, and no project at all, both fall through to the user
    // layer rather than to /repo/a's overlay.
    expect(formatOnSaveFor("/repo/b")).toBe(true);
    expect(formatOnSaveFor(null)).toBe(true);
  });

  it("stops answering once the selection clears", async () => {
    await useWorkspace("/repo/a", { minimap: true });
    expect(editorDefaults().minimap).toBe(true);

    await loadWorkspaceSettings(null);

    expect(editorDefaults().minimap).toBe(DEFAULT_SETTINGS.editorDefaults.minimap);
  });
});
