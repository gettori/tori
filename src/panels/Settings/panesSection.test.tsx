// The Panes section of the settings panel (plan phase 11 task 3): three rows,
// one per family of tabs, each writing its rule through `set_settings` without
// disturbing the two beside it.
//
// The rule *routing* is asserted through the shell in `appPinRules.test.tsx`;
// this is the half that rots on its own, a control that stops reaching the
// store while everything downstream of it still works.
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import Settings from "./Settings";
import { DEFAULT_SETTINGS, loadSettings, type PanePins } from "./settingsStore";
import { unstubbed } from "../../test/settingsBackend";

/** The shipped rules, taken before anything saves: the store proxies
 *  `DEFAULT_SETTINGS` itself, so a save writes through it. */
const PRISTINE: PanePins = structuredClone(DEFAULT_SETTINGS.panePins);

const ROWS: [string, keyof PanePins][] = [
  ["Terminals open in", "terminal"],
  ["Chats open in", "chat"],
  ["Files open in", "file"],
];

/** The select belonging to a labelled row. */
const selectFor = (label: string) => screen.getByText(label).closest("div")!.querySelector("button, select")!;

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "set_settings") return args.settings;
    if (cmd === "get_settings") return { ...DEFAULT_SETTINGS, panePins: structuredClone(PRISTINE) };
    return unstubbed(cmd);
  });
  await loadSettings();
});

describe("the Panes settings section", () => {
  it("offers a row per family, showing the rule that is stored", () => {
    render(() => <Settings onClose={() => {}} />);
    for (const [label, key] of ROWS) {
      const shown = selectFor(label).textContent ?? "";
      expect(shown.toLowerCase(), label).toContain(PRISTINE[key] === "rightmost" ? "right" : "left");
    }
  });

  it("writes the rule it was given, and leaves the other two alone", async () => {
    render(() => <Settings onClose={() => {}} />);
    // A Kobalte select opens on pointerdown and picks on pointerup; a bare
    // click reaches both and changes neither (see the helper).
    pointerClick(selectFor("Files open in") as HTMLElement);
    // By role, not by text: the trigger shows the current value, so a listbox
    // option and the button can carry the same words.
    pointerClick(await screen.findByRole("option", { name: "The leftmost pane" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_settings", expect.anything()));
    const [, args] = invoke.mock.calls.find(([c]) => c === "set_settings")!;
    const written = (args as { settings: { panePins: PanePins } }).settings.panePins;

    expect(written.file).toBe("leftmost");
    expect(written.terminal).toBe(PRISTINE.terminal);
    expect(written.chat).toBe(PRISTINE.chat);
  });
});
