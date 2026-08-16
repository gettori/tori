// The three settings pickers, after #106 moved them off the native `<select>`.
//
// Two things are being protected. The first is the **accessible name**: a
// `Row`'s label is a sibling of its control, not a wrapper, so a native
// `<select>` never inherited it and a `Select` (a button) cannot either. Each
// one now points at `rowLabelId`, and these tests read the name back off the
// control rather than trusting the attribute is there - the row's visible text
// and the name a screen reader announces are asserted to be the same string.
//
// The second is the **round trip**: the value reaches the store as the option's
// own string, and comes back as the trigger's label. Neither pane had coverage
// of that before, so the migration would otherwise have been guarded by
// nothing at all.
//
// **No pane-wide axe scan here, deliberately.** One was written and removed. It
// failed, and on controls this ticket does not touch: every native checkbox,
// number and text input in a `Row` is unlabelled for exactly the reason the
// selects were, since the row's `<label>` is a *sibling* of the control rather
// than its parent. Those are #107's to migrate and `rowLabelId` is now here for
// it to point them at. The scan also cost ~800ms of the serialized axe queue
// per pane, which was enough to tip a dialog suite's axe test past the 5s
// default timeout in a full run. The selects are axe-gated in
// `Select.test.tsx`, where the scan is small and the component is the subject;
// what these tests add is the association, asserted by querying each control
// *through* its visible label.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { setAppearance } from "./components/paneKit";
import { withAcpCatalog } from "../../test/settingsInvoke";
import { pointerClick } from "../../test/menus";
import ChatPane from "./panes/ChatPane/ChatPane";
import AppearancePane from "./panes/AppearancePane/AppearancePane";
import { DEFAULT_SETTINGS, loadWorkspaceSettings, settings } from "./settingsStore";

const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockImplementation(
    withAcpCatalog(async (cmd: string, args: Record<string, unknown>) =>
      cmd === "set_settings" ? args.settings : DEFAULT_SETTINGS),
  );
  await loadWorkspaceSettings(null);
});

/** Every row on screen, nothing filtered: the panes take the filter as props,
 *  and none of these tests is about search. */
const shown = () => true;
const paneProps = { shown, query: "" };

/** Pick `option` out of the picker named `name`. Two presses since #106: the
 *  rows only exist while the listbox is open. */
async function pick(name: string, option: string) {
  pointerClick(screen.getByLabelText(name));
  await screen.findByRole("listbox");
  pointerClick(screen.getByRole("option", { name: option }));
  await macrotask();
}

describe("the settings pickers", () => {
  describe("ChatPane", () => {
    it("names both pickers with the text of their own row", () => {
      render(() => <ChatPane {...paneProps} />);

      // Queried *by* the visible label, so a name that drifted from the row
      // fails here rather than passing against a hardcoded string.
      expect(screen.getByLabelText("Open sessions in")).toBeTruthy();
      expect(screen.getByLabelText("Transcript density")).toBeTruthy();
    });

    it("round-trips the default surface through the store", async () => {
      render(() => <ChatPane {...paneProps} />);
      expect(screen.getByLabelText("Open sessions in").textContent).toContain("Chat");

      await pick("Open sessions in", "Terminal (agent tab)");

      expect(settings.chatDefaults.defaultSurface).toBe("agent");
      expect(screen.getByLabelText("Open sessions in").textContent).toContain(
        "Terminal (agent tab)",
      );
    });

    it("round-trips the transcript density through the store", async () => {
      render(() => <ChatPane {...paneProps} />);
      expect(settings.chatDefaults.density).toBe("comfortable");

      await pick("Transcript density", "Compact");

      expect(settings.chatDefaults.density).toBe("compact");
      expect(screen.getByLabelText("Transcript density").textContent).toContain("Compact");
    });

  });

  describe("AppearancePane", () => {
    it("names the theme picker with the text of its own row", () => {
      render(() => <AppearancePane {...paneProps} />);
      expect(screen.getByLabelText("Theme")).toBeTruthy();
    });

    it("round-trips a theme choice through the store", async () => {
      render(() => <AppearancePane {...paneProps} />);

      await pick("Theme", "Sway Light");

      expect(settings.appearance.theme).toBe("sway-light");
      expect(screen.getByLabelText("Theme").textContent).toContain("Sway Light");
    });

    it("shows the painted theme when settings.json names one that is gone", async () => {
      // The registry falls back to the default for an id it does not know, so
      // binding the stored id directly would render the picker *blank*, which
      // reads as "no theme" rather than "that one is gone". The pane resolves
      // the unknown id before the control ever sees it.
      await setAppearance({ theme: "a-theme-that-was-deleted" });
      render(() => <AppearancePane {...paneProps} />);

      expect(screen.getByLabelText("Theme").textContent).toContain("Sway Dark");
    });

    it("omits the user group entirely when the themes folder is empty", async () => {
      render(() => <AppearancePane {...paneProps} />);

      pointerClick(screen.getByLabelText("Theme"));
      await screen.findByRole("listbox");

      expect(screen.getByText("Bundled")).toBeTruthy();
      expect(screen.queryByText("From ~/.config/sway/themes")).toBeNull();
    });

  });
});
