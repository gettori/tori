// The header search on the Settings panel, and the `Preferences: ...` command
// that opens the panel at one setting.
//
// Two modes, and which one you are in depends on how the query got there.
// Typing asks about every category, so all six answer at once and the rail
// selects nothing. A command points at one setting, so it lands you on that
// setting's category with the box seeded.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));


import Settings from "./Settings";
import { DEFAULT_SETTINGS, loadWorkspaceSettings } from "./settingsStore";
import { SETTING_TABS } from "../../utils/settingsCatalog";

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockImplementation(
    async (cmd: string, args: Record<string, unknown>) =>
      cmd === "set_settings" ? args.settings : DEFAULT_SETTINGS,
  );
  // The overlay outlives any one test, so a workspace selected elsewhere would
  // otherwise still be adding its buttons to these rows.
  await loadWorkspaceSettings(null);
});

const box = () => screen.getByLabelText("Search settings") as HTMLInputElement;
const type = (q: string) => fireEvent.input(box(), { target: { value: q } });

/** A list, not one element: all six show at once while a search is running. */
const panes = () =>
  [...document.querySelectorAll("[data-pane]:not([hidden])")] as HTMLElement[];

/** Null while results are showing: the rail claims no place then. */
const activeTab = () =>
  document.querySelector('[role="tab"][aria-selected="true"] span')?.textContent;

/** The labelled rows on screen, wherever they came from. */
const rows = () => panes().flatMap((p) => [...p.querySelectorAll("label")].map((el) => el.textContent));

const clickTab = (label: string) =>
  fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${label}`) }));

describe("the settings search box", () => {
  it("opens on Agents with that category's content and no query", () => {
    render(() => <Settings onClose={() => {}} />);
    expect(activeTab()).toBe("Agents");
    expect(box().value).toBe("");
    // The Agents pane is runtime cards rather than catalogue rows, so its own
    // filter box standing in the pane is the proof the category rendered.
    expect(screen.getByLabelText("Search agents")).toBeTruthy();
  });

  it("answers across every category, not inside the one you were on", () => {
    // A match in Editor is now a result you can read from Appearance.
    render(() => <Settings onClose={() => {}} />);
    clickTab("Appearance");

    type("minim");

    expect(rows()).toEqual(["Minimap"]);
    expect(panes()).toHaveLength(SETTING_TABS.length);
    // The neighbours the old section-level filter kept are gone: a count saying
    // "1" over a pane showing eleven rows is the state row granularity exists to
    // rule out.
    expect(rows()).not.toContain("Indentation guides");
  });

  it("holds your place in the rail for when you stop searching", () => {
    // Typing does not move you: clearing returns to where you were.
    render(() => <Settings onClose={() => {}} />);
    clickTab("Appearance");

    type("minim");
    expect(activeTab()).toBeUndefined();

    type("");
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
    // A lone switch floating under nothing is still the thing to avoid, and the
    // heading names its category because the rows around it came from elsewhere.
    render(() => <Settings onClose={() => {}} />);
    type("Stop at context");

    expect(rows()).toEqual(["Stop at context"]);
    expect(screen.getByText("Chat · Spending")).toBeTruthy();
    // And the groups with nothing left in them took their headings with them.
    expect(screen.queryByText("Chat · Sessions")).toBeNull();
  });
});

describe("Enter, the one keystroke that does navigate", () => {
  const enter = () => fireEvent.keyDown(box(), { key: "Enter" });

  it("goes to the category with the most matches, keeping the query", () => {
    // Results mode ends and the rail claims a place again, but the box keeps
    // what you typed: Enter is a decision about *where*, not a reset.
    render(() => <Settings onClose={() => {}} />);
    clickTab("Appearance");
    type("minim");
    expect(activeTab()).toBeUndefined();

    enter();

    expect(activeTab()).toBe("Editor");
    expect(rows()).toEqual(["Minimap"]);
  });

  it("resolves a tie to the earliest category in rail order", () => {
    // "adapters" ties Agents and Languages at one hint match each. The rule
    // falls out of a `>` scan keeping the first maximum; a `>=` would silently
    // turn it into "whichever category happened to be scanned last", which is
    // Languages here - so the fixture has to be a tie the two rules disagree
    // about.
    render(() => <Settings onClose={() => {}} />);
    type("adapters");
    expect(SETTING_TABS.findIndex((t) => t.id === "agents")).toBeLessThan(
      SETTING_TABS.findIndex((t) => t.id === "languages"),
    );

    enter();

    expect(activeTab()).toBe("Agents");
  });

  it("does nothing when the query matches nothing anywhere", () => {
    // Checked after clearing, because the rail selects nothing while results
    // are on screen: "did Enter move me?" can only be read once it does again.
    render(() => <Settings onClose={() => {}} />);
    clickTab("Appearance");
    type("zzzqqq");

    enter();

    type("");
    expect(activeTab()).toBe("Appearance");
  });

  it("never navigates on the keystrokes that built the query", () => {
    // The rule Enter is the exception to: typing "minim" from Appearance passes
    // through five states in which Editor is the highest-count category, and
    // none of them may move you.
    render(() => <Settings onClose={() => {}} />);
    clickTab("Appearance");
    for (const q of ["m", "mi", "min", "mini", "minim"]) {
      type(q);
      expect(activeTab(), q).toBeUndefined();
    }
    type("");
    expect(activeTab()).toBe("Appearance");
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

  it("lets the query be typed past straight away, and answers it as a search", () => {
    // The first keystroke past the seed switches to results, and the category
    // the command chose is still what clearing returns to.
    render(() => <Settings onClose={() => {}} query="Line height" />);
    expect(activeTab()).toBe("Appearance");

    // "Minimap" is an Editor setting, but this is typing, not a command.
    type("minim");

    expect(activeTab()).toBeUndefined();
    expect(rows()).toEqual(["Minimap"]);

    type("");
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

describe("a command that deep links to one row", () => {
  /** The row element a catalogue id renders as. */
  const row = (id: string) => document.getElementById(`settings-row-${id}`);

  it("lands focused on the row, not merely on its tab", async () => {
    // Phase 2 got you to the tab; a palette row names one setting, so the panel
    // owes it the row. Focus is what makes the next keystroke edit the thing you
    // asked for.
    render(() => <Settings onClose={() => {}} query="Sticky scroll" entry="sticky-scroll" />);

    await waitFor(() => expect(document.activeElement).toBe(row("sticky-scroll")!.querySelector("input")));
    expect(activeTab()).toBe("Editor");
  });

  it("flashes the row, then stops", async () => {
    // Focus alone is easy to miss on one checkbox in a list of checkboxes.
    render(() => <Settings onClose={() => {}} query="Minimap" entry="minimap" />);

    await waitFor(() => expect(row("minimap")!.className).toContain("rowFlash"));
    await waitFor(() => expect(row("minimap")!.className).not.toContain("rowFlash"), { timeout: 3000 });
  });

  it("re-targets a panel already open on another tab", async () => {
    const [entry, setEntry] = createSignal<string | undefined>(undefined);
    const [q, setQ] = createSignal("");
    render(() => <Settings onClose={() => {}} query={q()} entry={entry()} />);
    clickTab("Appearance");

    setQ("Minimap");
    setEntry("minimap");

    await waitFor(() => expect(document.activeElement).toBe(row("minimap")!.querySelector("input")));
    expect(activeTab()).toBe("Editor");
  });

  it("reaches a section whose controls only exist at runtime", async () => {
    // A card section has no row, so the deep link lands on the section itself
    // rather than doing nothing.
    render(() => <Settings onClose={() => {}} query="Debuggers" entry="debuggers" />);

    await waitFor(() => expect(row("debuggers")).toBeTruthy());
    expect(activeTab()).toBe("Languages");
  });

  it("does not put focus inside a card section", async () => {
    // Its contents are built at runtime, so the first control in it is whatever
    // that section happened to render - for GitHub, a sign-out button. Landing
    // focus there would arm the next Space or Enter. The scroll and the flash
    // still say "here", which is all a section without a control can offer.
    render(() => <Settings onClose={() => {}} query="GitHub" entry="github" />);

    await waitFor(() => expect(row("github")!.className).toContain("cardSectionHit"));
    expect(row("github")!.contains(document.activeElement)).toBe(false);
  });

  it("leaves the search box focused when no row was named", async () => {
    // An ordinary open still starts in the search box; only a deep link aims
    // focus elsewhere, and stealing it back would undo the point.
    render(() => <Settings onClose={() => {}} />);
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });
});
