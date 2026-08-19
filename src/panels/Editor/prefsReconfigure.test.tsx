// Turning a setting on, and off, reaches the live buffer.
//
// What this covers: the pane's settings effect runs `syncEditorPrefs`, the
// compartment reconfigures, and an extension that draws its own element both
// arrives and leaves with the preference. Nothing here types, scrolls or
// resizes in between, so a toggle that needed one of those to take effect
// would show up as a missing element.
//
// What this does NOT cover, stated because it is tempting to assume otherwise:
// the zero-width minimap that `syncEditorPrefs`'s trailing empty transaction
// exists to prevent. That bug is a *measurement* - the package's `render` reads
// `view.dom.clientWidth` - and jsdom reports every element as zero-sized, so it
// writes the same `0px` whether or not the plugin got the update it was missing.
// The failure and its fix were both reproduced in a real browser instead
// (`grimoire/smoke/`, Phase 12); removing the empty dispatch does not fail
// anything here.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";
const FILE = `${REPO}/a.ts`;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "fs_read_file":
        return Promise.resolve("const a = 1;\n".repeat(80));
      // The backend echoes what it wrote, and `saveSettings` puts that echo in
      // the store. Returning null here would blank the store instead.
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
  claimedByLsp: () => false,
  ensureLspFor: () => Promise.resolve(),
  lspPluginFor: () => [],
  lspTargetFor: () => null,
  notifyLspFileChanged: () => {},
  onLspChange: () => () => {},
  setSemanticRefreshListener: () => () => {},
  setCodeLensRefreshListener: () => () => {},
  stopAllLsp: () => Promise.resolve(), retainLspRoots: () => Promise.resolve(),
}));

const { default: CodeEditor } = await import("./CodeEditor");
const { MINIMAP_CLASS } = await import("./minimap");
const { saveSettings, DEFAULT_SETTINGS } = await import("../Settings/settingsStore");

let mounted: ReturnType<typeof render> | null = null;

async function mount() {
  const dirty: string[] = [];
  mounted = render(() => (
    <CodeEditor
      activePath={FILE}
      openPaths={[FILE]}
      projectRoot={REPO}
      goto={null}
      onDirty={(p) => dirty.push(p)}
      selected={null}
    />
  ));
  await waitFor(() => expect(dirty.length).toBeGreaterThan(0));
}

/** Flip one editor preference, leaving the rest at their defaults. The store
 *  path a real toggle takes, so the pane's own effect is what reacts. Built
 *  from the defaults rather than from the live store, which is a Solid proxy
 *  and cannot be cloned. */
function setEditorPref(patch: Partial<typeof DEFAULT_SETTINGS.editorDefaults>) {
  return saveSettings({
    ...structuredClone(DEFAULT_SETTINGS),
    editorDefaults: { ...DEFAULT_SETTINGS.editorDefaults, ...patch },
  });
}

beforeEach(async () => {
  await saveSettings(structuredClone(DEFAULT_SETTINGS));
});
afterEach(async () => {
  mounted?.unmount();
  mounted = null;
  await saveSettings(structuredClone(DEFAULT_SETTINGS));
});

describe("switching a preference on mid-session", () => {
  it("builds the extension's own element into the live buffer", async () => {
    await mount();
    expect(mounted!.container.querySelector(`.${MINIMAP_CLASS}`)).toBeNull();

    await setEditorPref({ minimap: true });

    await waitFor(() =>
      expect(mounted!.container.querySelector(`.${MINIMAP_CLASS}`)).toBeTruthy(),
    );
  });

  it("takes it away again when the preference goes off", async () => {
    await mount();
    await setEditorPref({ minimap: true });
    await waitFor(() => expect(mounted!.container.querySelector(`.${MINIMAP_CLASS}`)).toBeTruthy());

    await setEditorPref({ minimap: false });

    await waitFor(() => expect(mounted!.container.querySelector(`.${MINIMAP_CLASS}`)).toBeNull());
  });
});
