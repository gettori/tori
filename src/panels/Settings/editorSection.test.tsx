// The Editor section of the settings panel: does every declared preference get
// a row, and does flipping one reach `set_settings` without disturbing the
// others?
//
// The first half is the one that rots. A later wave-5 phase adds a key to
// `EditorDefaults`, wires the feature, and never touches this panel: the setting
// then exists, works when hand-edited, and is invisible to everyone who does
// not read settings.json.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));


import Settings, { EDITOR_TOGGLES } from "./Settings";
import { DEFAULT_SETTINGS, loadSettings, loadWorkspaceSettings, type EditorDefaults } from "./settingsStore";

beforeEach(() => {
  invoke.mockReset();
  // `set_settings` echoes what it was handed, the way the backend does.
  invoke.mockImplementation(
    async (cmd: string, args: Record<string, unknown>) =>
      cmd === "set_settings" ? args.settings : DEFAULT_SETTINGS,
  );
});

/** The `EditorDefaults` keys that are editor behaviour but not editing
 *  *comfort*: each has its own row, with its own explanation, above the toggle
 *  list. Named here rather than filtered by shape so adding one has to be a
 *  decision instead of a silent omission.
 *
 *  `organizeImportsOnSave` joined them in wave 7 rather than going in the
 *  comfort list, for the reason the list is separate at all: it rewrites the
 *  file on the way to disk, which is a paragraph's worth of consequence, not a
 *  line's worth of pixels.
 *
 *  `codeLens` joined them for a related but distinct reason: it is the one
 *  editor setting whose cost is paid whether or not anybody looks at what it
 *  draws, so the row has to be able to say that. */
const OWN_ROW: (keyof EditorDefaults)[] = ["formatOnSave", "organizeImportsOnSave", "codeActionsOnSave", "codeLens", "vimMode"];

/** Every comfort key of `EditorDefaults` that is a switch, read off the defaults
 *  so a key added to the type shows up here rather than as a silent gap on
 *  screen. A setting that is not a boolean cannot be a checkbox row: it has its
 *  own control, and the catalogue's `edits` field is what keeps *it* from going
 *  missing (see `settingsCatalog.test.tsx`). */
const EDITOR_KEYS = (Object.keys(DEFAULT_SETTINGS.editorDefaults) as (keyof EditorDefaults)[]).filter(
  (k) => !OWN_ROW.includes(k) && typeof DEFAULT_SETTINGS.editorDefaults[k] === "boolean",
);

/** The defaults as they were *before* anything saved. `DEFAULT_SETTINGS` is the
 *  object `createStore` proxies, so a save writes through it: comparing against
 *  it after a flip compares the new value with itself. */
const PRISTINE: EditorDefaults = structuredClone(DEFAULT_SETTINGS.editorDefaults);

/** The checkbox belonging to a labelled row. */
function boxFor(label: string): HTMLInputElement {
  const row = screen.getByText(label).closest("div")!;
  return row.querySelector('input[type="checkbox"]')!;
}

describe("the Editor settings section", () => {
  it("offers a row for every preference the type declares, and no stale ones", () => {
    const shown = EDITOR_TOGGLES.map((t) => t.key);
    expect([...shown].sort()).toEqual([...EDITOR_KEYS].sort());
    expect(new Set(shown).size).toBe(shown.length);
  });

  it("renders each row on the stored value", () => {
    render(() => <Settings onClose={() => {}} />);
    for (const t of EDITOR_TOGGLES) {
      expect(boxFor(t.label).checked, t.label).toBe(PRISTINE[t.key]);
    }
  });

  it("writes the flipped key through set_settings, carrying its siblings", async () => {
    render(() => <Settings onClose={() => {}} />);
    const minimap = EDITOR_TOGGLES.find((t) => t.key === "minimap")!;
    fireEvent.click(boxFor(minimap.label));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_settings", expect.anything()));
    const [, args] = invoke.mock.calls.find(([c]) => c === "set_settings")!;
    const written = (args as { settings: { editorDefaults: EditorDefaults } }).settings.editorDefaults;

    expect(written.minimap).toBe(true);
    // Exactly one key moved: the block is carried through, not rebuilt from
    // defaults, so a section written this way cannot reset a sibling.
    const moved = EDITOR_KEYS.filter((k) => written[k] !== PRISTINE[k]);
    expect(moved).toEqual(["minimap"]);
  });
});

describe("overriding a setting for one workspace", () => {
  const WS = "/space/proj/main";
  const minimap = () => EDITOR_TOGGLES.find((t) => t.key === "minimap")!;

  /** The controls beside a labelled row. */
  const rowOf = (label: string) => screen.getByText(label).closest("div")!;

  /**
   * Put the global layer back to what shipped, then select a workspace.
   *
   * The reset is not ceremony: `createStore` proxies `DEFAULT_SETTINGS` itself,
   * so an earlier test's save is still in the store when this one runs, and a
   * user layer that has drifted is exactly what these assertions are about.
   */
  async function useWorkspace(root: string | null, overlay: Record<string, unknown> = {}) {
    invoke.mockImplementation(
      async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "set_settings") return args.settings;
        if (cmd === "get_settings") return { ...DEFAULT_SETTINGS, editorDefaults: structuredClone(PRISTINE) };
        if (cmd === "get_workspace_settings") return { editor: overlay };
        if (cmd === "set_workspace_settings") return args.settings;
        return DEFAULT_SETTINGS;
      },
    );
    await loadSettings();
    await loadWorkspaceSettings(root);
  }

  const selectWorkspace = (overlay: Record<string, unknown> = {}) => useWorkspace(WS, overlay);

  it("offers nothing to override until a workspace is selected", async () => {
    await useWorkspace(null);
    render(() => <Settings onClose={() => {}} />);
    expect(screen.queryByText("Set here")).toBeNull();
    expect(screen.getByText(/Select a branch to override/)).toBeTruthy();
  });

  // The badge's one hard promise.
  it("badges a row only when the overlay is what supplies its value", async () => {
    await selectWorkspace({ minimap: true });
    render(() => <Settings onClose={() => {}} />);

    expect(rowOf(minimap().label).textContent).toContain("workspace");
    // Every other row follows the global setting and carries no badge.
    for (const t of EDITOR_TOGGLES.filter((t) => t.key !== "minimap")) {
      expect(rowOf(t.label).textContent, t.label).not.toContain("workspace");
    }
  });

  it("shows the overlay's answer, not the global one", async () => {
    await selectWorkspace({ minimap: true });
    render(() => <Settings onClose={() => {}} />);
    expect(PRISTINE.minimap).toBe(false);
    expect(boxFor(minimap().label).checked).toBe(true);
  });

  it("writes an override to this workspace without touching the global file", async () => {
    await selectWorkspace();
    render(() => <Settings onClose={() => {}} />);

    fireEvent.click(within(rowOf(minimap().label)).getByText("Set here"));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_workspace_settings", expect.anything()));
    const [, args] = invoke.mock.calls.find(([c]) => c === "set_workspace_settings")!;
    expect(args).toEqual({ root: WS, settings: { editor: { minimap: false } } });
    // A per-workspace pick is not a global one.
    expect(invoke.mock.calls.some(([c]) => c === "set_settings")).toBe(false);
  });

  it("hands the setting back to the global layer when the override is cleared", async () => {
    await selectWorkspace({ minimap: true });
    render(() => <Settings onClose={() => {}} />);

    fireEvent.click(within(rowOf(minimap().label)).getByText("Clear"));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_workspace_settings", expect.anything()));
    const [, args] = invoke.mock.calls.find(([c]) => c === "set_workspace_settings")!;
    // Cleared, not pinned to the value it happened to have.
    expect(args).toEqual({ root: WS, settings: { editor: {} } });
    expect(rowOf(minimap().label).textContent).not.toContain("workspace");
  });

  // A click that changed a value the row was not showing would read as broken.
  it("edits the layer the row is displaying", async () => {
    await selectWorkspace({ minimap: true });
    render(() => <Settings onClose={() => {}} />);

    fireEvent.click(boxFor(minimap().label));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_workspace_settings", expect.anything()));
    const [, args] = invoke.mock.calls.find(([c]) => c === "set_workspace_settings")!;
    expect(args).toEqual({ root: WS, settings: { editor: { minimap: false } } });
    expect(invoke.mock.calls.some(([c]) => c === "set_settings")).toBe(false);
  });

  it("leaves the workspace's answers behind when the selection clears", async () => {
    await selectWorkspace({ minimap: true });
    await loadWorkspaceSettings(null);
    render(() => <Settings onClose={() => {}} />);
    expect(rowOf(minimap().label).textContent).not.toContain("workspace");
    expect(boxFor(minimap().label).checked).toBe(PRISTINE.minimap);
  });
});
