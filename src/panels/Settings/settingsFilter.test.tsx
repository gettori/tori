// The header search on the Settings panel, and the `Preferences: ...` command
// that opens the panel at one setting.
//
// Rewritten when the panel became six tabs. What used to be asserted here was
// section granularity: a query narrowed the panel to whole sections. The
// contract now is row granularity *inside the tab you are on*, plus the one rule
// that makes count badges usable at all - **typing never moves you**. A command
// is the exception, because a palette row is the user pointing at one setting.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, fireEvent, within } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import Settings from "./Settings";
import { DEFAULT_SETTINGS, loadWorkspaceSettings } from "./settingsStore";

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

/** The one pane on screen. Every pane stays mounted (a switch must not lose a
 *  pane's scroll position), so a query about what is *visible* has to be asked
 *  of the tabpanel that is not `hidden`. */
const pane = () => document.querySelector('[role="tabpanel"]:not([hidden])') as HTMLElement;

/** The tab currently selected, by its label. */
const activeTab = () =>
  (document.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement | null)?.textContent;

/** The labelled rows on screen in the active pane. */
const rows = () => [...pane().querySelectorAll("label")].map((el) => el.textContent);

const clickTab = (label: string) => fireEvent.click(screen.getByRole("tab", { name: label }));

describe("the settings search box", () => {
  it("opens on Agents with every row of that tab and no query", () => {
    render(() => <Settings onClose={() => {}} />);
    expect(activeTab()).toBe("Agents");
    expect(box().value).toBe("");
    expect(rows()).toContain("Binary path");
  });

  it("filters to the matching rows within the active tab", () => {
    render(() => <Settings onClose={() => {}} />);
    clickTab("Editor");
    expect(rows()).toContain("Indentation guides");

    type("minim");

    expect(rows()).toEqual(["Minimap"]);
    // The neighbours the old section-level filter kept are gone: a badge saying
    // "1" over a pane showing eleven rows is the state row granularity exists to
    // rule out.
    expect(rows()).not.toContain("Indentation guides");
  });

  it("never changes the active tab while you type", () => {
    // The rule the whole search design rests on. "Minimap" lives in Editor, and
    // typing it from Appearance must leave you in Appearance.
    render(() => <Settings onClose={() => {}} />);
    clickTab("Appearance");

    type("minim");

    expect(activeTab()).toBe("Appearance");
    type("theme");
    expect(activeTab()).toBe("Appearance");
  });

  it("gives the whole pane back when the query is cleared", () => {
    render(() => <Settings onClose={() => {}} />);
    clickTab("Editor");
    const all = rows();

    type("minim");
    expect(rows().length).toBeLessThan(all.length);
    type("");

    expect(rows()).toEqual(all);
  });

  it("says so rather than showing an empty panel when nothing matches anywhere", () => {
    render(() => <Settings onClose={() => {}} />);
    type("zzzqqq");

    expect(screen.getByText(/No setting matches/)).toBeTruthy();
    expect(rows()).toEqual([]);
  });

  it("keeps a filtered row's group heading, so it is still read in context", () => {
    // What survives of the retired section-level rule: the granularity changed,
    // but a lone checkbox floating under nothing is still the thing to avoid.
    render(() => <Settings onClose={() => {}} />);
    clickTab("Chat");
    type("Stop at context");

    expect(rows()).toEqual(["Stop at context"]);
    expect(within(pane()).getByText("Spending")).toBeTruthy();
    // And the two groups with nothing left in them took their headings with them.
    expect(within(pane()).queryByText("Sessions")).toBeNull();
  });
});

describe("a command that opens the panel at one setting", () => {
  it("lands on the tab holding the match, seeded with the query", () => {
    render(() => <Settings onClose={() => {}} query="Line height" />);

    expect(box().value).toBe("Line height");
    expect(activeTab()).toBe("Appearance");
    expect(rows()).toEqual(["Line height"]);
  });

  it("lands on the Editor tab for an editor setting, from closed", () => {
    render(() => <Settings onClose={() => {}} query="Sticky scroll" />);

    expect(activeTab()).toBe("Editor");
    expect(rows()).toEqual(["Sticky scroll"]);
  });

  // ⌘K reaches the palette over this modal, and opening an already-open panel
  // remounts nothing: without the prop being watched, the row would close the
  // palette and appear to have done nothing at all.
  it("re-lands when it arrives at a panel already open on another tab", () => {
    const [q, setQ] = createSignal("");
    render(() => <Settings onClose={() => {}} query={q()} />);
    clickTab("Appearance");
    expect(activeTab()).toBe("Appearance");

    setQ("Sticky scroll");

    expect(box().value).toBe("Sticky scroll");
    expect(activeTab()).toBe("Editor");
    expect(rows()).toEqual(["Sticky scroll"]);
  });

  it("lets the query be typed past straight away, without moving the tab again", () => {
    render(() => <Settings onClose={() => {}} query="Line height" />);
    expect(activeTab()).toBe("Appearance");

    // "Minimap" is an Editor setting, but this is typing, not a command.
    type("minim");

    expect(activeTab()).toBe("Appearance");
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

  it("leaves the tab alone for a query nothing matches", () => {
    // Better than landing on the first tab and showing it empty: nothing was
    // pointed at, so nothing should move.
    render(() => <Settings onClose={() => {}} query="zzzqqq" />);
    expect(activeTab()).toBe("Agents");
  });
});
