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
import { render, screen, fireEvent, waitFor, within } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import Settings from "./Settings";
import { DEFAULT_SETTINGS, loadWorkspaceSettings } from "./settingsStore";
import { SETTING_TABS } from "../../utils/settingsCatalog";
import styles from "./Settings.module.css";

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

/** The tab currently selected, by its label alone. Read off the label span
 *  rather than the tab's `textContent`, which also carries the count badge once
 *  a query is running. */
const activeTab = () =>
  document.querySelector('[role="tab"][aria-selected="true"] span')?.textContent;

/** The labelled rows on screen in the active pane. */
const rows = () => [...pane().querySelectorAll("label")].map((el) => el.textContent);

/** Anchored rather than exact: once a query is running a tab's accessible name
 *  carries its match count too ("Editor, 1 match"). */
const clickTab = (label: string) =>
  fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${label}`) }));

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

  it("says how many matches are waiting elsewhere rather than moving you", () => {
    // The other half of stay-put. A blank pane with no explanation reads as a
    // broken search; the count plus the badges is what makes staying put a
    // choice rather than a dead end.
    render(() => <Settings onClose={() => {}} />);
    clickTab("Appearance");

    type("minim");

    expect(activeTab()).toBe("Appearance");
    expect(rows()).toEqual([]);
    expect(screen.getByText(/No matches here, 1 elsewhere/)).toBeTruthy();
    // Not the same message as "nothing matched at all", which is a query to fix.
    expect(screen.queryByText(/No setting matches/)).toBeNull();
  });

  it("says nothing matched anywhere, rather than pointing at other tabs", () => {
    render(() => <Settings onClose={() => {}} />);
    clickTab("Appearance");

    type("zzzqqq");

    expect(screen.getByText(/No setting matches/)).toBeTruthy();
    expect(screen.queryByText(/elsewhere/)).toBeNull();
  });

  it("drops the elsewhere note once you land on a tab that has matches", () => {
    render(() => <Settings onClose={() => {}} />);
    clickTab("Appearance");
    type("minim");
    expect(screen.getByText(/elsewhere/)).toBeTruthy();

    clickTab("Editor");

    expect(screen.queryByText(/elsewhere/)).toBeNull();
    expect(rows()).toEqual(["Minimap"]);
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

describe("Enter, the one keystroke that does navigate", () => {
  const enter = () => fireEvent.keyDown(box(), { key: "Enter" });

  it("goes to the tab with the most matches", () => {
    render(() => <Settings onClose={() => {}} />);
    clickTab("Appearance");
    type("minim");
    expect(activeTab()).toBe("Appearance");

    enter();

    expect(activeTab()).toBe("Editor");
    expect(rows()).toEqual(["Minimap"]);
  });

  it("resolves a tie to the earliest tab in strip order", () => {
    // "path" ties Agents and Editor at two matches each. The rule falls out of a
    // `>` scan keeping the first maximum; a `>=` would silently turn it into
    // "whichever tab happened to be scanned last", which is Editor here - so the
    // fixture has to be a tie the two rules disagree about, and this one is.
    render(() => <Settings onClose={() => {}} />);
    type("path");
    const badgeOf = (id: string) =>
      document.querySelector(`[role="tab"][id="settings-tab-${id}"] .${styles.badge}`)?.textContent;
    expect(badgeOf("agents")).toBe("2");
    expect(badgeOf("editor")).toBe("2");
    expect(SETTING_TABS.findIndex((t) => t.id === "agents")).toBeLessThan(
      SETTING_TABS.findIndex((t) => t.id === "editor"),
    );

    clickTab("Integrations");
    enter();

    expect(activeTab()).toBe("Agents");
  });

  it("does nothing when the query matches nothing anywhere", () => {
    render(() => <Settings onClose={() => {}} />);
    clickTab("Appearance");
    type("zzzqqq");

    enter();

    expect(activeTab()).toBe("Appearance");
  });

  it("never navigates on the keystrokes that built the query", () => {
    // The rule Enter is the exception to: typing "minim" from Appearance passes
    // through five states in which Editor is the highest-count tab, and none of
    // them may move you.
    render(() => <Settings onClose={() => {}} />);
    clickTab("Appearance");
    for (const q of ["m", "mi", "min", "mini", "minim"]) {
      type(q);
      expect(activeTab(), q).toBe("Appearance");
    }
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
