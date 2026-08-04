// The `Preferences: ...` commands, and the one property that makes them safe to
// add thirty of: a toggle fired from the palette lands in the same layer the
// panel's checkbox would.
//
// Anything else would make a key look dead. With a workspace overriding it, a
// flip written to the global file lands *under* the overlay, the overlay keeps
// winning, and the command does nothing however often it is run. That is the bug
// `toggleVimMode` carried before Phase 4's self-review, and generating a command
// per setting is what would have multiplied it by thirty.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import appSource from "../../App.tsx?raw";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import Settings from "./Settings";
import { DEFAULT_SETTINGS, loadSettings, loadWorkspaceSettings, toggleEditorDefault } from "./settingsStore";
import { COMMANDS } from "../../utils/commands";
import { onWith, PREFS_TOGGLE, type PrefsToggle } from "../../utils/events";

const WS = "/space/proj/main";
const PRISTINE = structuredClone(DEFAULT_SETTINGS.editorDefaults);

/** The listener App installs, stood up here so a command can be run end to end
 *  rather than only observed emitting. That App is the one that installs it is
 *  asserted separately below. */
let off: (() => void) | undefined;

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "set_settings") return args.settings;
    if (cmd === "get_settings") return { ...DEFAULT_SETTINGS, editorDefaults: structuredClone(PRISTINE) };
    if (cmd === "get_workspace_settings") return { editor: overlay };
    if (cmd === "set_workspace_settings") return args.settings;
    return DEFAULT_SETTINGS;
  });
  off?.();
  off = onWith<PrefsToggle>(PREFS_TOGGLE, ({ key }) => toggleEditorDefault(key));
  overlay = {};
  await loadSettings();
  await loadWorkspaceSettings(null);
});

let overlay: Record<string, unknown> = {};

async function selectWorkspace(next: Record<string, unknown>) {
  overlay = next;
  await loadWorkspaceSettings(WS);
}

/** Run the palette row for one setting, by the id the table generates. */
function runCommand(id: string) {
  const c = COMMANDS.find((c) => c.id === id);
  expect(c, `${id} is not in the command table`).toBeTruthy();
  c!.run!();
}

/** The arguments of the one call to a backend command, or undefined. */
function callTo(cmd: string): unknown {
  return invoke.mock.calls.find(([c]) => c === cmd)?.[1];
}

describe("a Preferences toggle from the palette", () => {
  it("writes the user's settings file where no workspace overrides the key", async () => {
    runCommand("prefs:minimap");

    await waitFor(() => expect(callTo("set_settings")).toBeTruthy());
    const written = (callTo("set_settings") as { settings: { editorDefaults: Record<string, boolean> } }).settings;
    expect(written.editorDefaults.minimap).toBe(!PRISTINE.minimap);
    expect(callTo("set_workspace_settings")).toBeUndefined();
  });

  it("writes the overlay where the workspace is what supplies the value", async () => {
    await selectWorkspace({ minimap: true });

    runCommand("prefs:minimap");

    await waitFor(() => expect(callTo("set_workspace_settings")).toBeTruthy());
    expect(callTo("set_workspace_settings")).toEqual({ root: WS, settings: { editor: { minimap: false } } });
    // The global answer is left exactly where it was, which is the point: the
    // override is this project's, and the flip was made inside it.
    expect(callTo("set_settings")).toBeUndefined();
  });

  it("lands where the panel's own checkbox lands, for the same key", async () => {
    // The verify stated as a comparison rather than as a claim: both surfaces go
    // through `setEditorDefault`, so this fails the moment one of them stops.
    await selectWorkspace({ compactFolders: false });
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(
      screen.getByText("Compact single-child folders").closest("div")!.querySelector('input[type="checkbox"]')!,
    );
    await waitFor(() => expect(callTo("set_workspace_settings")).toBeTruthy());
    const byHand = callTo("set_workspace_settings");

    invoke.mockClear();
    await selectWorkspace({ compactFolders: false });
    runCommand("prefs:compact-folders");

    await waitFor(() => expect(callTo("set_workspace_settings")).toBeTruthy());
    expect(callTo("set_workspace_settings")).toEqual(byHand);
  });

  it("flips what the layers resolve to, not what the settings file happens to hold", async () => {
    // The overlay says off while the user's file says on: a toggle reading the
    // middle layer would write "off" and appear to do nothing.
    await loadSettings();
    await selectWorkspace({ hotExit: false });
    expect(PRISTINE.hotExit).toBe(true);

    runCommand("prefs:hot-exit");

    await waitFor(() => expect(callTo("set_workspace_settings")).toBeTruthy());
    expect(callTo("set_workspace_settings")).toEqual({ root: WS, settings: { editor: { hotExit: true } } });
  });
});

describe("a Preferences row for a setting nothing can toggle", () => {
  it("opens the panel at it instead of guessing at a value", () => {
    const emitted: string[] = [];
    const stop = onWith<{ query?: string }>("sway:open-settings", ({ query }) => emitted.push(query ?? ""));
    runCommand("prefs:line-height");
    stop();

    expect(emitted).toEqual(["Line height"]);
    // And nothing was written on the way.
    expect(callTo("set_settings")).toBeUndefined();
  });
});

it("is wired up by App, which is where the store is global and the panel is not", () => {
  // The listener above stands in for App's. Source-scanned rather than rendered:
  // App pulls the whole tree, and what is being checked is a two-line wiring
  // that would otherwise be the only untested link in the chain.
  expect(appSource).toContain("PREFS_TOGGLE");
  expect(appSource).toContain("toggleEditorDefault");
  expect(appSource).toContain("OPEN_SETTINGS");
});
