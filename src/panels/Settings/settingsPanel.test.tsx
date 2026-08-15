// The Settings panel's shell: the tab strip, the panes under it, and the dialog
// semantics the panel shipped without.
//
// Two things are being protected here. The first is coverage: eleven catalogue
// sections were split across six panes by hand, and a setting dropped on the way
// is invisible rather than broken. The second is that `aria-modal` is a claim -
// focus has to actually stay inside, or the attribute is a lie a screen reader
// believes.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { withAcpCatalog } from "../../test/settingsInvoke";

import Settings from "./Settings";
import { DEFAULT_SETTINGS, loadWorkspaceSettings, setZoom, zoom, zoomIn } from "./settingsStore";
import { blameOn, reloadBlamePref, writeBlamePref } from "../../utils/blamePref";
import { reloadSideBySide, sideBySideOn, writeSideBySide } from "../../utils/sideBySide";
import { SETTINGS, SETTING_TABS } from "../../utils/settingsCatalog";
import styles from "./Settings.module.css";

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockImplementation(
    withAcpCatalog(async (cmd: string, args: Record<string, unknown>) =>
      cmd === "set_settings" ? args.settings : DEFAULT_SETTINGS),
  );
  await loadWorkspaceSettings(null);
});

/** The four catalogue entries that stand for a whole section rather than for a
 *  row: their controls are built at runtime (a card per agent found, a row per
 *  server installed), so they have a section on screen and no `<label>`. */
const CARD_ENTRIES: Record<string, string> = {
  agents: "Agents",
  "language-servers": "Language servers",
  debuggers: "Debuggers",
  github: "GitHub",
};

const tabs = () => [...document.querySelectorAll('[role="tab"]')] as HTMLElement[];
const panes = () => [...document.querySelectorAll('[role="tabpanel"]')] as HTMLElement[];
/** The selected tab's label alone: a tab's `textContent` also carries the count
 *  badge once a query is running. */
const activeTab = () =>
  document.querySelector('[role="tab"][aria-selected="true"] span')?.textContent;
/** Every tab's label, in strip order. */
const tabLabels = () => tabs().map((t) => t.querySelector("span")?.textContent);
const strip = () => document.querySelector('[role="tablist"]') as HTMLElement;
const panel = () => document.querySelector('[role="dialog"]') as HTMLElement;
const box = () => screen.getByLabelText("Search settings") as HTMLInputElement;

describe("the settings tab strip", () => {
  it("renders one tab per catalogue tab, in strip order", () => {
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

  it("switches on arrow keys, wrapping, with Home and End at the ends", () => {
    render(() => <Settings onClose={() => {}} />);
    expect(activeTab()).toBe("Agents");

    fireEvent.keyDown(strip(), { key: "ArrowRight" });
    expect(activeTab()).toBe("Chat");

    fireEvent.keyDown(strip(), { key: "ArrowLeft" });
    expect(activeTab()).toBe("Agents");

    // Wraps rather than stopping, which is what `nextSegmentIndex` does.
    fireEvent.keyDown(strip(), { key: "ArrowLeft" });
    expect(activeTab()).toBe("Integrations");

    fireEvent.keyDown(strip(), { key: "Home" });
    expect(activeTab()).toBe("Agents");
    fireEvent.keyDown(strip(), { key: "End" });
    expect(activeTab()).toBe("Integrations");
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

describe("the per-tab match counts", () => {
  const type = (q: string) =>
    fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: q } });
  /** Each tab's badge, in strip order, or null where a tab has none. Selected by
   *  the badge's own class, not by position: a tab always ends in its label
   *  span, so `span:last-child` reads the label back when there is no badge. */
  const badges = () => tabs().map((t) => t.querySelector(`.${styles.badge}`)?.textContent ?? null);

  it("shows no badges until something is typed", () => {
    render(() => <Settings onClose={() => {}} />);
    expect(badges().every((b) => b === null || b === "")).toBe(true);
  });

  it("counts the matches per tab for a fixture query", () => {
    render(() => <Settings onClose={() => {}} />);
    // "font" is the three family rows, the three size rows, and Zoom - whose
    // hint says it scales "on top of the font sizes below" - all in Appearance,
    // and nothing anywhere else.
    type("font");
    const counts = Object.fromEntries(SETTING_TABS.map((t, i) => [t.label, badges()[i]]));
    expect(counts.Appearance).toBe("7");
    expect(counts.Editor).toBe("0");
    expect(counts.Chat).toBe("0");
  });

  it("agrees with the number of rows the pane then shows", () => {
    // The badge's one promise. A count the user cannot check against what they
    // see is worse than no count.
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: /^Chat/ }));
    type("Dollars");

    const pane = document.querySelector('[role="tabpanel"]:not([hidden])') as HTMLElement;
    const shownRows = pane.querySelectorAll("label").length;
    expect(badges()[1]).toBe(String(shownRows));
  });

  it("keeps every tab mounted and clickable when a query matches nothing in it", () => {
    // Dimmed, not removed: dropping a tab would move the other five out from
    // under the pointer, and a zero-match tab is still somewhere to go.
    render(() => <Settings onClose={() => {}} />);
    type("font");
    expect(tabs()).toHaveLength(SETTING_TABS.length);

    fireEvent.click(screen.getByRole("tab", { name: /^Editor/ }));
    expect(activeTab()).toContain("Editor");
  });

  it("does not unmount a tab as the query narrows", () => {
    render(() => <Settings onClose={() => {}} />);
    const before = tabs();
    type("f");
    type("fo");
    type("font");
    // Same element identities, so nothing remounted and nothing reflowed from a
    // tab appearing or disappearing mid-keystroke.
    expect(tabs()).toEqual(before);
  });
});

describe("marking what matched, in the pane", () => {
  const type = (q: string) =>
    fireEvent.input(screen.getByLabelText("Search settings"), { target: { value: q } });
  const pane = () => document.querySelector('[role="tabpanel"]:not([hidden])') as HTMLElement;

  it("marks the matched part of a label", () => {
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: /^Editor/ }));
    type("minim");

    expect([...pane().querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Minim"]);
  });

  it("marks the matched part of a hint when the label did not match", () => {
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: /^Editor/ }));
    type("Prettier");

    // "Prettier" appears only in Format on save's explanation, never in a label.
    const marked = [...pane().querySelectorAll("mark")].map((m) => m.textContent);
    expect(marked).toEqual(["Prettier"]);
  });

  it("indicates every unit the badge counted, in the pane", () => {
    // The promise that ties the two halves together: a badge saying N and a pane
    // where fewer than N things are visibly indicated is a count you cannot
    // check. Card sections count as one and are marked whole.
    render(() => <Settings onClose={() => {}} />);
    for (const [tabName, query] of [
      [/^Appearance/, "font"],
      [/^Chat/, "Dollars"],
      [/^Editor/, "wrap"],
      [/^Languages/, "debug adapters"],
    ] as const) {
      fireEvent.click(screen.getByRole("tab", { name: tabName }));
      type(query);
      const rows = pane().querySelectorAll("label").length;
      const cards = pane().querySelectorAll(`.${styles.cardSectionHit}`).length;
      const marked = pane().querySelectorAll("mark").length;
      expect(rows === 0 || marked, `${query}: rows on screen with nothing marked`).toBeTruthy();
      expect(rows + cards, `${query}: nothing indicated`).toBeGreaterThan(0);
    }
  });

  it("keeps the vertical rhythm the wrapper took away", () => {
    // Wrapping a `<section>` makes it `:first-child` of its own div, so the
    // `.section:first-child` rule zeroes its top margin. Two stacked card
    // sections (Language servers over Debuggers) would butt together unless the
    // wrapper carries that rhythm instead.
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: /^Languages/ }));

    const wrappers = pane().querySelectorAll(`.${styles.cardSection}`);
    expect(wrappers).toHaveLength(2);
    for (const w of wrappers) expect(w.querySelector("section")).toBeTruthy();
  });

  it("marks a card section whole, having no row to mark inside it", () => {
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: /^Languages/ }));
    type("debug adapters");

    expect(pane().querySelectorAll(`.${styles.cardSectionHit}`)).toHaveLength(1);
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

  it("puts each tab's count in its accessible name", () => {
    // A bare number floating beside a word says nothing when read aloud.
    render(() => <Settings onClose={() => {}} />);
    type("font");
    expect(screen.getByRole("tab", { name: "Appearance, 7 matches" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Editor, 0 matches" })).toBeTruthy();
  });

  it("says “1 match”, not “1 matches”", () => {
    render(() => <Settings onClose={() => {}} />);
    type("minim");
    expect(screen.getByRole("tab", { name: "Editor, 1 match" })).toBeTruthy();
  });

  it("leaves the tab names alone when no query is running", () => {
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

    expect(live().textContent).toBe("7 settings in 1 tab");
  });

  it("announces only the last total after a burst of keystrokes", () => {
    render(() => <Settings onClose={() => {}} />);
    for (const q of ["m", "mi", "min", "mini", "minim"]) {
      type(q);
      vi.advanceTimersByTime(100);
    }
    expect(live().textContent).toBe("");

    vi.advanceTimersByTime(600);

    expect(live().textContent).toBe("1 setting in 1 tab");
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

  it("lands on the Agents tab in welcome mode", () => {
    // First run opens here: it is the tab that answers "will this work with my
    // setup?", and the note points at the cards under it.
    render(() => <Settings onClose={() => {}} welcome />);
    expect(activeTab()).toBe("Agents");
    expect(screen.getByText(/Welcome to Sway/)).toBeTruthy();
  });

  // The greeting branches on whether anything is installed. Telling a user with
  // no CLI to "check which ones it found below" points them at a list of misses
  // and reads as Sway being broken rather than as a step they have not taken.
  const withOnboarding = (content: unknown) =>
    withAcpCatalog(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "onboarding_content") return content;
      return cmd === "set_settings" ? args.settings : DEFAULT_SETTINGS;
    });

  it("tells a machine with no harness what to install, naming them", async () => {
    invoke.mockImplementation(
      withOnboarding({ kind: "noHarness", supported: ["Claude", "Codex", "OpenCode"] }),
    );
    render(() => <Settings onClose={() => {}} welcome />);
    const note = await screen.findByText(/could not find one yet/);
    expect(note.textContent).toContain("Claude, Codex or OpenCode");
    expect(screen.queryByText(/checking which ones it found below/)).toBeNull();
  });

  it("gives the ordinary greeting once one harness resolves", async () => {
    invoke.mockImplementation(withOnboarding({ kind: "firstRun" }));
    render(() => <Settings onClose={() => {}} welcome />);
    expect(await screen.findByText(/checking which ones it found below/)).toBeTruthy();
    expect(screen.queryByText(/could not find one yet/)).toBeNull();
  });

  // A backend that cannot answer must not leave the first-run panel with no
  // greeting at all.
  it("falls back to the ordinary greeting when the check fails", async () => {
    invoke.mockImplementation(
      withAcpCatalog(async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "onboarding_content") throw new Error("nope");
        return cmd === "set_settings" ? args.settings : DEFAULT_SETTINGS;
      }),
    );
    render(() => <Settings onClose={() => {}} welcome />);
    expect(await screen.findByText(/checking which ones it found below/)).toBeTruthy();
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
    expect(localStorage.getItem("sway.zoom")).toBe("1.5");
  });

  it("clamps a zoom the store would refuse rather than showing a value it is not at", () => {
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));

    fireEvent.change(numberFor("Zoom"), { target: { value: "900" } });

    expect(zoom()).toBe(3);
    expect(numberFor("Zoom").value).toBe("300");
  });

  it("switches blame and side-by-side through the shared preference", () => {
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Editor" }));

    fireEvent.click(boxFor("Git blame"));
    expect(blameOn()).toBe(true);
    expect(localStorage.getItem("sway.editor.blame")).toBe("1");

    fireEvent.click(boxFor("Side-by-side diffs"));
    expect(sideBySideOn()).toBe(true);
    expect(localStorage.getItem("sway.review.sideBySide")).toBe("1");
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
    const stops = [...panel().querySelectorAll<HTMLElement>("button, input, select, textarea")].filter(
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

    const last = [...panel().querySelectorAll<HTMLElement>("button, input, select, textarea")].filter(
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
});
