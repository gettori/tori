// The Settings panel's shell: the tab strip, the panes under it, and the dialog
// semantics the panel shipped without.
//
// Two things are being protected here. The first is coverage: eleven catalogue
// sections were split across six panes by hand, and a setting dropped on the way
// is invisible rather than broken. The second is that `aria-modal` is a claim -
// focus has to actually stay inside, or the attribute is a lie a screen reader
// believes.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import Settings from "./Settings";
import { DEFAULT_SETTINGS, loadWorkspaceSettings } from "./settingsStore";
import { SETTINGS, SETTING_TABS } from "../../utils/settingsCatalog";

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) =>
    cmd === "set_settings" ? args.settings : DEFAULT_SETTINGS,
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
const activeTab = () =>
  (document.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement | null)?.textContent;
const strip = () => document.querySelector('[role="tablist"]') as HTMLElement;
const panel = () => document.querySelector('[role="dialog"]') as HTMLElement;
const box = () => screen.getByLabelText("Search settings") as HTMLInputElement;

describe("the settings tab strip", () => {
  it("renders one tab per catalogue tab, in strip order", () => {
    render(() => <Settings onClose={() => {}} />);
    expect(tabs().map((t) => t.textContent)).toEqual(SETTING_TABS.map((t) => t.label));
  });

  it("gives every tab a glyph, so no tab names an icon the panel cannot resolve", () => {
    // The catalogue stores a lucide *name* (it is reachable from the terminal's
    // chunk, so it must not import components). This is the map that pays for
    // them, and a name with no entry renders a tab with a hole in it.
    render(() => <Settings onClose={() => {}} />);
    for (const t of tabs()) expect(t.querySelector("svg"), t.textContent ?? "").toBeTruthy();
  });

  it("points each tab at its pane and labels the pane back", () => {
    render(() => <Settings onClose={() => {}} />);
    for (const [i, tab] of tabs().entries()) {
      const paneEl = panes()[i];
      expect(tab.getAttribute("aria-controls")).toBe(paneEl.id);
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

    // Wraps rather than stopping, which is what `nextSegmentIndex` already does
    // for the segmented control.
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
