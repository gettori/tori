// Code lens, wired: the setting reaches every buffer, not just the one on
// screen.
//
// The decisions themselves are unit-tested in `lspCodeLens.test.ts` and
// `codeLensWidget.test.tsx`. What is left to get wrong is the seam between
// them and the pane, and it has one specific failure that neither of those can
// see: a buffer built while the setting was on keeps its own configuration
// while it sits in the background, so switching the setting off reaches only
// the tab in the view. Swapping back to the other tab then shows lenses under
// a setting that says they are off, which reads as the toggle not working.
//
// That is why the compartment is reconfigured through `reconfigureBuffers`
// (`state.update` for the buffers in no view) rather than through the
// `prefsConf` dispatch beside it, and this is the test that says so.
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";
const A = `${REPO}/a.ts`;
const B = `${REPO}/b.ts`;

/** What the fake server answers `textDocument/codeLens` with, by file. Titled
 *  differently so "which file's lenses am I looking at" is answerable. */
const LENS: Record<string, string> = { [A]: "3 references", [B]: "7 references" };

let asked: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "fs_read_file":
        return Promise.resolve("export function f() {}\nexport function g() {}\n");
      case "set_settings":
        return Promise.resolve(args.settings);
      case "git_status":
      case "git_diff_file":
      case "fs_read_dir":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  },
  convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

vi.mock("./lspClient", () => ({
  claimedByLsp: () => true,
  ensureLspFor: () => Promise.resolve(),
  lspPluginFor: () => [],
  lspTargetFor: (path: string) => ({
    root: REPO,
    ready: Promise.resolve(),
    // Titles arrive with the lens, so this server needs no resolve step: what
    // is under test here is the wiring, not the round trip.
    supports: (cap: string) => cap === "codeLensProvider",
    capability: () => ({}),
    sync: () => {},
    request: (method: string) => {
      asked.push(`${method} ${path}`);
      if (method !== "textDocument/codeLens") return Promise.resolve(null);
      return Promise.resolve([
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          command: { title: LENS[path], command: "noop" },
        },
      ]);
    },
  }),
  lspTargets: () => [],
  executeServerCommand: () => Promise.resolve(null),
  notifyLspFileChanged: () => {},
  onLspChange: () => () => {},
  setSemanticRefreshListener: () => () => {},
  setCodeLensRefreshListener: () => () => {},
  stopAllLsp: () => Promise.resolve(), stopEvictedLspRoots: () => Promise.resolve(),
}));

const { default: CodeEditor } = await import("./CodeEditor");
const { saveSettings, DEFAULT_SETTINGS } = await import("../Settings/settingsStore");

let mounted: ReturnType<typeof render> | null = null;
let setActive: (path: string) => void = () => {};

async function mount() {
  const [active, set] = createSignal(A);
  setActive = set;
  const dirty: string[] = [];
  mounted = render(() => (
    <CodeEditor
      activePath={active()}
      openPaths={[A, B]}
      projectRoot={REPO}
      goto={null}
      onDirty={(p) => dirty.push(p)}
      selected={null}
    />
  ));
  await waitFor(() => expect(dirty.length).toBeGreaterThan(0));
}

/** Flip the code lens preference the way a real toggle does, through the store,
 *  so the pane's own effect is what reacts. */
function setCodeLensPref(on: boolean) {
  return saveSettings({
    ...structuredClone(DEFAULT_SETTINGS),
    editorDefaults: { ...DEFAULT_SETTINGS.editorDefaults, codeLens: on },
  });
}

const strips = () => [...mounted!.container.querySelectorAll(".cm-codeLens")].map((s) => s.textContent);

beforeEach(async () => {
  asked = [];
  await saveSettings(structuredClone(DEFAULT_SETTINGS));
});
afterEach(async () => {
  mounted?.unmount();
  mounted = null;
  await saveSettings(structuredClone(DEFAULT_SETTINGS));
});

describe("code lens behind its setting", () => {
  it("asks nothing at all while the setting is off", async () => {
    // The reason it is a setting: this is the one language feature nobody
    // asked a question to get, so with it off it must cost not a slow request
    // but no request. The default is off, so this is what every user gets.
    await mount();
    expect(asked.filter((a) => a.startsWith("textDocument/codeLens"))).toEqual([]);
    expect(strips()).toEqual([]);
  });

  it("draws them once the setting is switched on, without waiting for an edit", async () => {
    await mount();
    await setCodeLensPref(true);
    await waitFor(() => expect(strips()).toEqual(["3 references"]));
  });

  it("shows no lenses in a background tab after the setting goes off", async () => {
    // The failure this exists for, in order: B is opened while lenses are on
    // and paints some, then goes into the background; the setting goes off
    // while A is on screen; swapping back to B must not bring B's lenses with
    // it. Reaching only the shown buffer is the shape of that bug.
    await mount();
    await setCodeLensPref(true);
    await waitFor(() => expect(strips()).toEqual(["3 references"]));

    setActive(B);
    await waitFor(() => expect(strips()).toEqual(["7 references"]));
    setActive(A);
    await waitFor(() => expect(strips()).toEqual(["3 references"]));

    await setCodeLensPref(false);
    await waitFor(() => expect(strips()).toEqual([]));

    setActive(B);
    // Long enough for a swap that *did* bring them back to have done so: the
    // assertion is about an absence, and an absence is true too early for free.
    await waitFor(() => expect(mounted!.container.textContent).toContain("export function"));
    expect(strips()).toEqual([]);
  });
});
