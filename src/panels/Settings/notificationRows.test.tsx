import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import Settings from "./Settings";
import { DEFAULT_SETTINGS, loadSettings, type NotificationSettings, type Settings as Stored } from "./settingsStore";
import { unstubbed } from "../../test/settingsBackend";

/** Taken before any test runs: the store's `createStore` wraps
 *  `DEFAULT_SETTINGS` itself, so a save writes through it. */
const PRISTINE: NotificationSettings = structuredClone(DEFAULT_SETTINGS.notifications);

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: { settings?: Stored }) => {
    if (cmd === "set_settings") return args.settings;
    if (cmd === "get_settings") return { ...DEFAULT_SETTINGS, notifications: structuredClone(PRISTINE) };
    return unstubbed(cmd);
  });
  await loadSettings();
});

const saved = (): NotificationSettings[] =>
  invoke.mock.calls.filter(([cmd]) => cmd === "set_settings").map(([, args]) => (args as { settings: Stored }).settings.notifications);

const ROWS: [string, NotificationSettings][] = [
  ["Notify when a session needs you", { needsYou: { notify: false, sound: false }, turnFinished: { notify: false, sound: false } }],
  ["Play a sound when a session needs you", { needsYou: { notify: true, sound: true }, turnFinished: { notify: false, sound: false } }],
  ["Notify when a chat finishes its turn", { needsYou: { notify: true, sound: false }, turnFinished: { notify: true, sound: false } }],
  ["Play a sound when a chat finishes its turn", { needsYou: { notify: true, sound: false }, turnFinished: { notify: false, sound: true } }],
];

describe("the Notifications settings group", () => {
  it("starts with the needs you notification on and the rest off", () => {
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: /^Chat/ }));
    const on = ROWS.map(([name]) => screen.getByRole("switch", { name }).getAttribute("aria-checked"));
    expect(on).toEqual(["true", "false", "false", "false"]);
  });

  it.each(ROWS)("%s writes its own key and nothing else", async (name, expected) => {
    render(() => <Settings onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: /^Chat/ }));
    fireEvent.click(screen.getByRole("switch", { name }));
    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]).toEqual(expected);
  });
});
