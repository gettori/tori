import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import AppearancePane from "./AppearancePane";
import { loadWorkspaceSettings } from "../../settingsStore";
import { listThemes } from "../../../../theme/bundled";
import { publishUserThemes } from "../../../../theme/userThemes";
import { unstubbed } from "../../../../test/settingsBackend";
import { setAppearance } from "../../components/paneKit";

beforeEach(async () => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) =>
    cmd === "set_settings" ? args.settings : unstubbed(cmd),
  );
  await loadWorkspaceSettings(null);
});
afterEach(() => publishUserThemes({ themes: [], errors: [] }));

describe("a catalog theme on the Appearance pane", () => {
  it("offers Update pack and Remove pack on the selected theme", async () => {
    const palette = { ...listThemes()[0].palette, id: "nord", label: "Nord" };
    publishUserThemes({
      themes: [
        {
          palette,
          source: "/cfg/packs/themes/nord.json",
          provenance: { source: "catalog", updateAvailable: true, catalogConflict: false },
        },
      ],
      errors: [],
    });
    await setAppearance({ theme: "nord" });
    render(() => <AppearancePane shown={() => true} query="" />);

    fireEvent.click(await waitFor(() => screen.getByLabelText("Update the Nord pack")));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("packs_update", { kind: "themes", id: "nord" }));
    const remove = () => screen.getByLabelText("Remove the Nord pack") as HTMLButtonElement;
    await waitFor(() => expect(remove().disabled).toBe(false));
    fireEvent.click(remove());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("packs_remove", { kind: "themes", id: "nord" }));
  });
});
