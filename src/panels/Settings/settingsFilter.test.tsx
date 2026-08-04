// The filter box on the Settings panel, and the `Preferences: ...` command that
// opens the panel at one setting.
//
// The panel is long enough that finding a setting is the thing you do before
// changing it, so what is asserted here is that a query narrows it and that
// clearing the query gives the whole panel back, not a subset of it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, fireEvent } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import Settings from "./Settings";
import { DEFAULT_SETTINGS, loadWorkspaceSettings } from "./settingsStore";
import { SECTION_TITLES } from "../../utils/settingsCatalog";

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) =>
    cmd === "set_settings" ? args.settings : DEFAULT_SETTINGS,
  );
  // The overlay outlives any one test, so a workspace selected elsewhere would
  // otherwise still be adding its buttons to these rows.
  await loadWorkspaceSettings(null);
});

const box = () => screen.getByLabelText("Search settings") as HTMLInputElement;
const type = (q: string) => fireEvent.input(box(), { target: { value: q } });

/** Section titles currently on screen. Read off the headings rather than the
 *  catalogue, so this counts what was actually rendered. */
function sectionsOnScreen(): string[] {
  return [...document.querySelectorAll("section > div:first-child")].map((el) => el.textContent ?? "");
}

describe("the settings filter box", () => {
  it("opens showing every section", () => {
    render(() => <Settings onClose={() => {}} />);
    for (const title of new Set(Object.values(SECTION_TITLES))) {
      expect(sectionsOnScreen(), title).toContain(title);
    }
  });

  it("narrows to the section holding a partly-typed setting name", () => {
    render(() => <Settings onClose={() => {}} />);
    type("minim");

    expect(screen.getByText("Minimap")).toBeTruthy();
    expect(sectionsOnScreen()).toEqual(["Editor"]);
    // The neighbours a filtered-by-row panel would have taken away.
    expect(screen.getByText("Indentation guides")).toBeTruthy();
    expect(screen.queryByText("Line height")).toBeNull();
  });

  it("gives the whole panel back when the query is cleared", () => {
    render(() => <Settings onClose={() => {}} />);
    const all = sectionsOnScreen();

    type("minim");
    expect(sectionsOnScreen().length).toBeLessThan(all.length);
    type("");

    expect(sectionsOnScreen()).toEqual(all);
  });

  it("says so rather than showing an empty panel when nothing matches", () => {
    render(() => <Settings onClose={() => {}} />);
    type("zzzqqq");

    expect(sectionsOnScreen()).toEqual([]);
    expect(screen.getByText(/No setting matches/)).toBeTruthy();
  });

  // What a `Preferences: ...` command does for a setting it cannot toggle: it
  // opens the panel *at* the setting rather than guessing at a value for it.
  it("opens filtered when a command hands it a query", () => {
    render(() => <Settings onClose={() => {}} query="Line height" />);

    expect(box().value).toBe("Line height");
    expect(sectionsOnScreen()).toEqual(["Typography"]);
  });

  it("lets the query be typed past straight away", () => {
    render(() => <Settings onClose={() => {}} query="Line height" />);
    type("Theme");

    expect(sectionsOnScreen()).toEqual(["Appearance"]);
  });

  // ⌘K reaches the palette over this modal, and opening an already-open panel
  // remounts nothing: without the prop being watched, the row would close the
  // palette and appear to have done nothing at all.
  it("re-filters when a command arrives at a panel that is already open", () => {
    const [q, setQ] = createSignal("");
    render(() => <Settings onClose={() => {}} query={q()} />);
    expect(sectionsOnScreen().length).toBeGreaterThan(1);

    setQ("Line height");

    expect(box().value).toBe("Line height");
    expect(sectionsOnScreen()).toEqual(["Typography"]);
  });

  it("does not overwrite what is being typed while no command has fired", () => {
    // The prop is watched, not bound. A re-render for any other reason must not
    // yank the box back to what the panel opened with.
    const [unrelated, setUnrelated] = createSignal(0);
    render(() => <Settings onClose={() => {}} query="Line height" welcome={unrelated() > 0} />);
    type("Theme");

    setUnrelated(1);

    expect(box().value).toBe("Theme");
  });
});
