// The Settings panel's shell: the category rail, the panes beside it, and the
// dialog semantics the panel shipped without.
//
// Two things are being protected here. The first is coverage: eleven catalogue
// sections were split across six panes by hand, and a setting dropped on the way
// is invisible rather than broken. The second is that `aria-modal` is a claim -
// focus has to actually stay inside, or the attribute is a lie a screen reader
// believes.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));


import Settings, { FOCUSABLE } from "./Settings";
import { loadWorkspaceSettings, setZoom, zoom, zoomIn } from "./settingsStore";
import { blameOn, reloadBlamePref, writeBlamePref } from "../../utils/blamePref";
import { reloadSideBySide, sideBySideOn, writeSideBySide } from "../../utils/sideBySide";
import { SETTINGS, SETTING_TABS } from "../../utils/settingsCatalog";
import {
  COMPOSE_DRAFT,
  OPEN_IN_EDITOR,
  OPEN_JOB,
  emitWith,
  type ComposeDraft,
  type OpenInEditor,
  type OpenJob,
} from "../../utils/events";
import { rowDomId } from "./components/paneKit";
import styles from "./Settings.module.css";
import { unstubbed } from "../../test/settingsBackend";

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockImplementation(
    async (cmd: string, args: Record<string, unknown>) =>
      cmd === "set_settings" ? args.settings : unstubbed(cmd),
  );
  await loadWorkspaceSettings(null);
});

/** The eight catalogue entries that stand for a whole section rather than for a
 *  row: their controls are built at runtime (a card per agent found, a row per
 *  server installed), so they have a section on screen and no `<label>`.
 *
 *  `agents` is checked by the id its `CardSection` carries rather than by text.
 *  Its heading is parked, and the word "Agents" is also the rail's own label
 *  for the tab, so a text search would pass on the rail item while the pane
 *  rendered nothing at all. */
const CARD_ENTRIES: Record<string, string> = {
  "language-servers": "Language servers",
  debuggers: "Debuggers",
  linters: "Linters",
  formatters: "Formatters",
  "trusted-projects": "Trusted projects",
  git: "Git",
  forge: "Hosts",
};
/** Entries the pane anchors by id rather than drawing as a `<label>` row: the
 *  agents table, and Advanced's base-folder card and its two danger boxes,
 *  whose titles are headings on a box and not labels for a control. */
const ANCHORED_ENTRIES = ["agents", "base-folder", "crash-logs", "change-base-folder", "forget-base-folder"];
/** Entries whose control lives on **an account's card**, on an agent's own
 *  detail page, which the panel reaches only once a reader picks an agent. They
 *  are in the catalogue because that is what the filter searches and what the
 *  palette generates a row from; they are exempt here because the pane this
 *  test renders shows the agents table, and the page carrying them is a click
 *  away. Their own controls are asserted in `agentAccounts.test.tsx`. *
 *  The five `agent-*` file kinds are exempt for a sharper version of the same
 *  reason: what they name is resolved per account *and* per adapter, so there
 *  is no control here at all, only a row on the page listing what is on disk.
 *  Their rows are asserted in `agentFiles.test.tsx`. */
const DETAIL_PAGE_ENTRIES = [
  "titlebar-preview",
  "usage-warn-at",
  "usage-notify",
  "agent-instructions",
  "agent-skills",
  "agent-commands",
  "agent-subagents",
  "agent-settings-file",
];

const tabs = () => [...document.querySelectorAll('[role="tab"]')] as HTMLElement[];
const panes = () => [...document.querySelectorAll('[role="tabpanel"]')] as HTMLElement[];
/** The selected rail item's label alone: an item's `textContent` also carries
 *  its standing count where it has one. */
const activeTab = () =>
  document.querySelector('[role="tab"][aria-selected="true"] span')?.textContent;
/** Every rail item's label, in rail order. */
const tabLabels = () => tabs().map((t) => t.querySelector("span")?.textContent);
const strip = () => document.querySelector('[role="tablist"]') as HTMLElement;
const panel = () => document.querySelector('[role="dialog"]') as HTMLElement;
const box = () => screen.getByLabelText("Search settings") as HTMLInputElement;

/** Every pane the panel is currently showing. **A list, not one element**: one
 *  category is on screen when nothing is typed, and all six are while a search
 *  is running, because results are grouped across them. */
const shownPanes = () =>
  [...document.querySelectorAll("[data-pane]:not([hidden])")] as HTMLElement[];
const shownRows = () => shownPanes().flatMap((p) => [...p.querySelectorAll("label")]);
const shownMarks = () => shownPanes().flatMap((p) => [...p.querySelectorAll("mark")]);

describe("the settings rail", () => {
  it("renders one item per catalogue tab, in rail order", () => {
    render(() => <Settings onClose={() => {}} />);
    expect(tabLabels()).toEqual(SETTING_TABS.map((t) => t.label));
  });

  it("gives every tab a glyph, so no tab names an icon the panel cannot resolve", () => {
    // The catalogue stores a lucide *name* (it is reachable from the terminal's
    // chunk, so it must not import components). This is the map that pays for
    // them, and a name with no entry renders a tab with a hole in it.
    render(() => <Settings onClose={() => {}} />);
    for (const t of tabs()) expect(t.querySelector("svg"), t.textContent ?? "").toBeTruthy();
  });

  it("points the selected tab at its pane and labels every pane back", () => {
    // `aria-controls` on the *selected* tab only, which is Kobalte's reading of
    // the practice rather than an omission: the attribute is what a reader
    // follows to jump into the panel, and only one panel is on screen. Every
    // pane still names its own tab, in both directions for the one that is
    // showing.
    render(() => <Settings onClose={() => {}} />);
    for (const [i, tab] of tabs().entries()) {
      const paneEl = panes()[i];
      const selected = tab.getAttribute("aria-selected") === "true";
      expect(tab.getAttribute("aria-controls")).toBe(selected ? paneEl.id : null);
      expect(paneEl.getAttribute("aria-labelledby")).toBe(tab.id);
    }
  });

  it("shows exactly one pane, and keeps the rest mounted but hidden", () => {
    // Mounted, so a tab switch keeps each pane's scroll position and any half-
    // typed field; hidden, so they stay out of the focus order.
    render(() => <Settings onClose={() => {}} />);
    expect(panes()).toHaveLength(SETTING_TABS.length);
    expect(panes().filter((p) => !p.hasAttribute("hidden"))).toHaveLength(1);
  });

  it("switches on click", () => {
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(activeTab()).toBe("Chat");
    expect(panes()[1].hasAttribute("hidden")).toBe(false);
  });

  it("groups the items under the rail's two headings", () => {
    // The headings group and go nowhere, so they must not be items: a heading
    // that answered to a click or an arrow key would be a stop with no pane.
    render(() => <Settings onClose={() => {}} />);
    const rail = strip();
    for (const group of ["Workbench", "Application"]) {
      const heading = [...rail.children].find((el) => el.textContent === group);
      expect(heading, `${group} heading missing from the rail`).toBeTruthy();
      expect(heading!.getAttribute("role")).toBeNull();
    }
  });

  it("switches on arrow keys, wrapping, with Home and End at the ends", () => {
    render(() => <Settings onClose={() => {}} />);
    expect(activeTab()).toBe("Agents");

    fireEvent.keyDown(strip(), { key: "ArrowRight" });
    expect(activeTab()).toBe("Chat");

    fireEvent.keyDown(strip(), { key: "ArrowLeft" });
    expect(activeTab()).toBe("Agents");

    // Wraps rather than stopping, which is what `nextSegmentIndex` does.
    fireEvent.keyDown(strip(), { key: "ArrowLeft" });
    expect(activeTab()).toBe("Advanced");

    fireEvent.keyDown(strip(), { key: "Home" });
    expect(activeTab()).toBe("Agents");
    fireEvent.keyDown(strip(), { key: "End" });
    expect(activeTab()).toBe("Advanced");
  });

  it("keeps one tab stop for the whole strip", () => {
    // Roving tabindex: Tab steps past the strip into the pane rather than
    // through six pills.
    render(() => <Settings onClose={() => {}} />);
    const stops = tabs().filter((t) => t.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
    expect(stops[0].getAttribute("aria-selected")).toBe("true");
  });
});

describe("searching across every category at once", () => {
  const type = (q: string) =>
    fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: q } });
  const count = () => document.querySelector(`.${styles.resultCount}`)?.textContent;

  it("shows one category and no count until something is typed", () => {
    render(() => <Settings onClose={() => {}} />);
    expect(shownPanes()).toHaveLength(1);
    expect(count()).toBeUndefined();
  });

  it("opens every category's matches at once, in rail order", () => {
    // The whole point of the change: results are not somewhere else to go to.
    // "path" matches the agent binary override and two editor rows, so a
    // stay-put filter would have shown one of the two and counted the other.
    render(() => <Settings onClose={() => {}} />);
    type("path");
    expect(shownPanes().length).toBe(SETTING_TABS.length);
    expect(shownRows().length).toBeGreaterThan(0);
  });

  it("counts what it found, and the count is the rows it drew", () => {
    // The count's one promise. A number the user cannot check against what they
    // see is worse than no number. Card sections stand for a whole section and
    // draw a row of their own, so they count exactly once here too.
    render(() => <Settings onClose={() => {}} />);
    // The two money ceilings; the context one is a percentage and says so.
    type("Dollars");
    expect(count()).toBe("2 settings matching");
    expect(shownRows()).toHaveLength(2);
  });

  it("says “1 setting”, not “1 settings”", () => {
    render(() => <Settings onClose={() => {}} />);
    type("minim");
    expect(count()).toBe("1 setting matching");
  });

  it("names the category a group of results came from", () => {
    // A heading reading "Editing" in a list drawn from six panes does not place
    // it; the rail is no longer holding your place while you read.
    render(() => <Settings onClose={() => {}} />);
    type("minim");
    const headings = shownPanes().flatMap((p) =>
      [...p.querySelectorAll("section > div:first-child")].map((el) => el.textContent),
    );
    expect(headings).toEqual(["Editor · Editing"]);
  });

  it("leaves the rail selecting nothing while results are on screen", () => {
    // Selection is a claim about what the pane is showing, and the pane is
    // showing results from everywhere.
    render(() => <Settings onClose={() => {}} />);
    type("font");
    expect(document.querySelector('[role="tab"][aria-selected="true"]')).toBeNull();
  });

  it("goes back to one category when the rail is used, clearing the query", () => {
    render(() => <Settings onClose={() => {}} />);
    type("font");
    fireEvent.click(screen.getByRole("tab", { name: /^Editor/ }));
    expect(box().value).toBe("");
    expect(activeTab()).toBe("Editor");
    expect(shownPanes()).toHaveLength(1);
  });

  it("does not unmount a rail item as the query narrows", () => {
    render(() => <Settings onClose={() => {}} />);
    const before = tabs();
    type("f");
    type("fo");
    type("font");
    // Same element identities, so nothing remounted and nothing reflowed from an
    // item appearing or disappearing mid-keystroke.
    expect(tabs()).toEqual(before);
  });
});

describe("marking what matched, in the pane", () => {
  const type = (q: string) =>
    fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: q } });
  const pane = () => document.querySelector('[role="tabpanel"]:not([hidden])') as HTMLElement;

  it("marks the matched part of a label", () => {
    render(() => <Settings onClose={() => {}} />);
    type("minim");

    expect(shownMarks().map((m) => m.textContent)).toEqual(["Minim"]);
  });

  it("marks the matched part of a hint when the label did not match", () => {
    render(() => <Settings onClose={() => {}} />);
    type("Prettier");

    // "Prettier" appears only in Format on save's explanation, never in a label.
    expect(shownMarks().map((m) => m.textContent)).toEqual(["Prettier"]);
  });

  it("indicates every unit the count counted, on screen", () => {
    // The promise that ties the two halves together: a count saying N and a pane
    // where fewer than N things are visibly indicated is a number you cannot
    // check. Card sections count as one and draw one row.
    render(() => <Settings onClose={() => {}} />);
    for (const query of ["font", "Dollars", "wrap", "debug adapters"]) {
      type(query);
      const rows = shownRows().length;
      const marked = shownMarks().length;
      expect(rows === 0 || marked, `${query}: rows on screen with nothing marked`).toBeTruthy();
      expect(rows, `${query}: nothing indicated`).toBeGreaterThan(0);
    }
  });

  it("keeps the vertical rhythm the wrapper took away", () => {
    // Wrapping a `<section>` makes it `:first-child` of its own div, so the
    // `.section:first-child` rule zeroes its top margin. Two stacked card
    // sections (Git and Hosts) would butt together unless the wrapper carries
    // that rhythm instead.
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: /^Integrations/ }));

    const wrappers = pane().querySelectorAll(`.${styles.cardSection}`);
    expect(wrappers).toHaveLength(2);
    for (const w of wrappers) expect(w.querySelector("section")).toBeTruthy();
  });

  it("offers a card section as one result rather than unfolding it", () => {
    // These four build a card per thing found at runtime. A agent grid and a
    // 31-entry catalogue expanding into a list of matching *settings* is the
    // wall the redesign removed, so a match says where it is and offers to go.
    render(() => <Settings onClose={() => {}} />);
    type("debug adapters");

    const hits = shownPanes().flatMap((p) => [...p.querySelectorAll(`.${styles.cardSectionHit}`)]);
    expect(hits).toHaveLength(1);
    expect(hits[0].querySelector("section")).toBeNull();
    expect(screen.getByRole("button", { name: "Open Debuggers" })).toBeTruthy();
  });

  it("takes you to the category a card section result names", () => {
    render(() => <Settings onClose={() => {}} />);
    type("debug adapters");
    fireEvent.click(screen.getByRole("button", { name: "Open Debuggers" }));

    expect(activeTab()).toBe("Debuggers");
    expect(pane().querySelectorAll(`.${styles.cardSection}`)).toHaveLength(1);
  });

  it("marks nothing at all when no query is running", () => {
    render(() => <Settings onClose={() => {}} />);
    expect(document.querySelectorAll("mark")).toHaveLength(0);
    expect(document.querySelectorAll(`.${styles.cardSectionHit}`)).toHaveLength(0);
  });
});

describe("what a screen reader is told about the search", () => {
  const type = (q: string) =>
    fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: q } });
  const live = () => document.querySelector('[aria-live="polite"]') as HTMLElement;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("leaves the rail item names alone when no query is running", () => {
    render(() => <Settings onClose={() => {}} />);
    expect(screen.getByRole("tab", { name: "Editor" })).toBeTruthy();
  });

  it("announces the aggregate once the typing stops", () => {
    render(() => <Settings onClose={() => {}} />);
    type("font");
    // Nothing yet: `polite` queues rather than replaces, so announcing per
    // keystroke would read out a backlog of stale totals.
    expect(live().textContent).toBe("");

    vi.advanceTimersByTime(600);

    expect(live().textContent).toBe("7 settings match");
  });

  it("announces only the last total after a burst of keystrokes", () => {
    render(() => <Settings onClose={() => {}} />);
    for (const q of ["m", "mi", "min", "mini", "minim"]) {
      type(q);
      vi.advanceTimersByTime(100);
    }
    expect(live().textContent).toBe("");

    vi.advanceTimersByTime(600);

    expect(live().textContent).toBe("1 setting matches");
  });

  it("says so when nothing matched", () => {
    render(() => <Settings onClose={() => {}} />);
    type("zzzqqq");
    vi.advanceTimersByTime(600);
    expect(live().textContent).toBe("No settings match");
  });
});

describe("the six panes", () => {
  it("gives every catalogue setting exactly one row, somewhere", () => {
    // The split was done by hand across six files. A setting dropped from all of
    // them still has a type, a command and a backend field, and is invisible.
    render(() => <Settings onClose={() => {}} />);
    const labels = [...document.querySelectorAll("label")].map((el) => el.textContent);
    for (const s of SETTINGS) {
      if (ANCHORED_ENTRIES.includes(s.id)) {
        expect(document.getElementById(rowDomId(s.id)), s.id).toBeTruthy();
        continue;
      }
      if (DETAIL_PAGE_ENTRIES.includes(s.id)) continue;
      if (s.id in CARD_ENTRIES) {
        expect(screen.getAllByText(CARD_ENTRIES[s.id]).length, s.id).toBeGreaterThan(0);
        continue;
      }
      expect(labels.filter((l) => l === s.label).length, `${s.id} (${s.label})`).toBe(1);
    }
  });

  it("no longer titles two groups “Editor”", () => {
    // The duplicate that read as a rendering bug: `editor` and `editing` are one
    // subject to the eye and were both titled "Editor" in one scrolling column.
    render(() => <Settings onClose={() => {}} />);
    const titles = [...document.querySelectorAll("section > div:first-child")].map((el) => el.textContent);
    expect(titles.filter((t) => t === "Editor")).toEqual([]);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("the rows backed by localStorage rather than by settings.json", () => {
  const pane = () => document.querySelector('[role="tabpanel"]:not([hidden])') as HTMLElement;
  const boxFor = (label: string) =>
    screen.getByText(label).closest("div")!.querySelector('input[type="checkbox"]') as HTMLInputElement;
  const numberFor = (label: string) =>
    screen.getByText(label).closest("div")!.querySelector('input[type="number"]') as HTMLInputElement;

  beforeEach(() => {
    localStorage.clear();
    reloadBlamePref();
    reloadSideBySide();
    setZoom(1);
  });

  it("shows zoom as a percentage of the live value", () => {
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    expect(numberFor("Zoom").value).toBe("100");
  });

  it("keeps the row and the zoom hotkeys in step, both ways", () => {
    // One signal, one setter. A row holding its own copy would show 100% while
    // ⌘= had already scaled the window.
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));

    zoomIn();
    expect(numberFor("Zoom").value).toBe("110");

    fireEvent.change(numberFor("Zoom"), { target: { value: "150" } });
    expect(zoom()).toBe(1.5);
    // Persisted, so it survives a restart the way ⌘= already did.
    expect(localStorage.getItem("tori.zoom")).toBe("1.5");
  });

  it("clamps a zoom the store would refuse rather than showing a value it is not at", () => {
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));

    fireEvent.change(numberFor("Zoom"), { target: { value: "900" } });

    expect(zoom()).toBe(3);
    expect(numberFor("Zoom").value).toBe("300");
  });

  it("puts the field back when the entry resolves to the value already stored", async () => {
    // The gap the clamping test above leaves open. That one types a value the
    // store *changes* to, so the signal moves and the field re-renders with it.
    // When the entry resolves to the value already held, nothing changes,
    // nothing re-renders, and the field is left showing text the setting never
    // took: a row reading 900 whose "+" is disabled at 300.
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    setZoom(3);
    expect(numberFor("Zoom").value).toBe("300");

    fireEvent.change(numberFor("Zoom"), { target: { value: "900" } });

    expect(zoom()).toBe(3);
    expect(numberFor("Zoom").value).toBe("300");
  });

  it("puts the field back when it is emptied", async () => {
    // Blank is not a value a bounded stepper can hold, so it resolves to the
    // one already stored - which is the same no-op path, and left the field
    // permanently empty.
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));

    fireEvent.change(numberFor("Zoom"), { target: { value: "" } });

    expect(zoom()).toBe(1);
    expect(numberFor("Zoom").value).toBe("100");
  });

  it("snaps a typed value onto the step it offers", async () => {
    // Tool output lines moves in fives. Without snapping, a typed 12 is stored
    // as 12, and from there the buttons walk 17, 22 while the field's own Up
    // arrow walks 15, 20 - two controls on one row disagreeing about the same
    // setting.
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));

    fireEvent.change(numberFor("Tool output lines"), { target: { value: "12" } });

    await waitFor(() => expect(numberFor("Tool output lines").value).toBe("10"));
  });

  it("switches blame and side-by-side through the shared preference", () => {
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));

    fireEvent.click(boxFor("Git blame"));
    expect(blameOn()).toBe(true);
    expect(localStorage.getItem("tori.editor.blame")).toBe("1");

    fireEvent.click(boxFor("Side-by-side diffs"));
    expect(sideBySideOn()).toBe(true);
    expect(localStorage.getItem("tori.review.sideBySide")).toBe("1");
  });

  it("follows a change made anywhere else, live", () => {
    // The reason both preferences became module-level signals: the editor's own
    // blame button and every diff surface write the same value, and a row that
    // had copied it at mount would sit there stale.
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    expect(boxFor("Git blame").checked).toBe(false);

    writeBlamePref(true);
    writeSideBySide(true);

    expect(boxFor("Git blame").checked).toBe(true);
    expect(boxFor("Side-by-side diffs").checked).toBe(true);
  });

  it("takes each new row's hint from the catalogue rather than restating it", () => {
    // The hint is what the search matches on, so a pane that repeated the text
    // would leave two copies to drift - a row explaining one thing while the
    // query that found it matched another.
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    for (const id of ["blame", "side-by-side-diff"]) {
      const hint = SETTINGS.find((s) => s.id === id)!.hint!;
      expect(screen.getAllByText(hint).length, id).toBe(1);
    }
  });

  it("gives neither row a workspace badge, having no overlay layer under it", () => {
    // They are localStorage, not `editorDefaults`, so "Set here" would write
    // somewhere nothing reads.
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
    for (const label of ["Git blame", "Side-by-side diffs", "Zoom"]) {
      const row = screen.getByText(label).closest("div")!;
      expect(row.textContent, label).not.toContain("Set here");
      expect(row.textContent, label).not.toContain("workspace");
    }
    expect(pane()).toBeTruthy();
  });
});

describe("the dialog shell", () => {
  it("announces itself as a modal dialog", () => {
    render(() => <Settings onClose={() => {}} />);
    expect(panel().getAttribute("aria-modal")).toBe("true");
    expect(panel().getAttribute("aria-label")).toBe("Settings");
  });

  it("wraps Tab at both ends rather than letting focus leave", () => {
    render(() => <Settings onClose={() => {}} />);
    const stops = [...panel().querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => !el.closest("[hidden]") && el.getAttribute("tabindex") !== "-1",
    );
    const first = stops[0];
    const last = stops[stops.length - 1];
    expect(first).not.toBe(last);

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("leaves the hidden panes out of the focus order", () => {
    // They are in the DOM, so a trap that walked the whole subtree would cycle
    // through five panes of controls nobody can see.
    render(() => <Settings onClose={() => {}} />);
    const hiddenInput = panes()
      .filter((p) => p.hasAttribute("hidden"))
      .flatMap((p) => [...p.querySelectorAll("input")])[0];
    expect(hiddenInput, "a hidden pane has controls to exclude").toBeTruthy();

    const last = [...panel().querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => !el.closest("[hidden]") && el.getAttribute("tabindex") !== "-1",
    );
    expect(last).not.toContain(hiddenInput);
  });
});

describe("Escape", () => {
  const escape = (from: HTMLElement = box()) => fireEvent.keyDown(from, { key: "Escape" });

  it("closes when there is no query to clear", () => {
    const onClose = vi.fn();
    render(() => <Settings onClose={onClose} />);
    escape();
    expect(onClose).toHaveBeenCalled();
  });

  it("clears the query first and closes only on the second press", () => {
    const onClose = vi.fn();
    render(() => <Settings onClose={onClose} />);
    fireEvent.input(box(), { target: { value: "minim" } });

    escape();
    expect(box().value).toBe("");
    expect(onClose).not.toHaveBeenCalled();

    escape();
    expect(onClose).toHaveBeenCalled();
  });

  it("clears the query wherever focus is inside the dialog", () => {
    // A user who tabbed to a tab pill still means "clear the search" on the
    // first press. The handler sits on the panel rather than on each control,
    // and the focus trap is what makes that cover everywhere focus can be.
    const onClose = vi.fn();
    render(() => <Settings onClose={onClose} />);
    fireEvent.input(box(), { target: { value: "minim" } });
    const tab = document.querySelector('[role="tab"][tabindex="0"]') as HTMLElement;
    tab.focus();

    escape(tab);

    expect(box().value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not reach over a surface opened on top of the panel", () => {
    // ⌘K opens the command palette *over* this modal, and the palette closes on
    // its own Escape handler. A capture-phase listener on `window` up here would
    // swallow that keystroke and clear this search box instead, so the palette
    // would appear stuck. Standing in for the palette with a sibling outside the
    // dialog, which is what a separate Portal is.
    const onClose = vi.fn();
    render(() => <Settings onClose={onClose} />);
    fireEvent.input(box(), { target: { value: "minim" } });

    const overlay = document.createElement("input");
    document.body.append(overlay);
    overlay.focus();
    fireEvent.keyDown(overlay, { key: "Escape" });
    overlay.remove();

    expect(box().value).toBe("minim");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on a backdrop click", () => {
    const onClose = vi.fn();
    render(() => <Settings onClose={onClose} />);
    fireEvent.mouseDown(panel().parentElement!);
    expect(onClose).toHaveBeenCalled();
  });

  // Two of the panel's buttons (Sign in, Install) start a command, and the
  // panel is a modal over the workspace: without this the command's tab would
  // open behind the still-open overlay, which reads as the button doing nothing.
  it("closes when something inside it starts a command", () => {
    const onClose = vi.fn();
    render(() => <Settings onClose={onClose} />);
    emitWith<OpenJob>(OPEN_JOB, {
      id: "install:copilot",
      title: "Install Copilot",
      cwd: "/home/me",
      program: "npm",
      args: ["install", "-g", "@github/copilot"],
      interactive: true,
    });
    expect(onClose).toHaveBeenCalled();
  });

  // Same rule for the Files rows. A tab opened behind the modal, or a draft
  // waiting in a composer nobody can see, reads the same way.
  it("closes when a row opens a file or hands a draft to an agent", () => {
    const opened = vi.fn();
    render(() => <Settings onClose={opened} />);
    emitWith<OpenInEditor>(OPEN_IN_EDITOR, { path: "/home/me/.claude/CLAUDE.md" });
    expect(opened).toHaveBeenCalled();

    const drafted = vi.fn();
    render(() => <Settings onClose={drafted} />);
    emitWith<ComposeDraft>(COMPOSE_DRAFT, { blocks: [{ type: "text", text: "hi" }] });
    expect(drafted).toHaveBeenCalled();
  });
});
