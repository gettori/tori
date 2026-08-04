// The Editor section of the settings panel: does every declared preference get
// a row, and does flipping one reach `set_settings` without disturbing the
// others?
//
// The first half is the one that rots. A later wave-5 phase adds a key to
// `EditorDefaults`, wires the feature, and never touches this panel: the setting
// then exists, works when hand-edited, and is invisible to everyone who does
// not read settings.json.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import Settings, { EDITOR_TOGGLES } from "./Settings";
import { DEFAULT_SETTINGS, type EditorDefaults } from "./settingsStore";

beforeEach(() => {
  invoke.mockReset();
  // `set_settings` echoes what it was handed, the way the backend does.
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) =>
    cmd === "set_settings" ? args.settings : DEFAULT_SETTINGS,
  );
});

/** The two `EditorDefaults` keys that are editor behaviour but not editing
 *  *comfort*: each has its own row, with its own explanation, above the toggle
 *  list. Named here rather than filtered by shape so adding a third has to be a
 *  decision instead of a silent omission. */
const OWN_ROW: (keyof EditorDefaults)[] = ["formatOnSave", "vimMode"];

/** Every comfort key of `EditorDefaults`, read off the defaults so a key added
 *  to the type shows up here rather than as a silent gap on screen. */
const EDITOR_KEYS = (Object.keys(DEFAULT_SETTINGS.editorDefaults) as (keyof EditorDefaults)[]).filter(
  (k) => !OWN_ROW.includes(k),
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
