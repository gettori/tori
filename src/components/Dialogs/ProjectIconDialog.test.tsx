import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";

// `convertFileSrc` turns a path into an asset URL the webview can load, and it
// reads Tauri's injected internals to do it. There is no host here, so it is
// stubbed to something recognisable: what the assertions care about is that the
// chosen path reaches the preview at all, not what the real protocol spells.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

const { default: ProjectIconDialog } = await import("./ProjectIconDialog");

// Characterization test for the project icon picker. Contract / shape split as
// in `ConfirmDialog.test.tsx`.
//
// The behaviour that matters is that the three ways to have an icon are one
// selection, not a stack of fallbacks: automatic, an uploaded image, and a
// glyph from the picker each un-choose the other two. The payload says which,
// by which key is present, so the assertions read the payload rather than the
// highlight wherever they can. That contract is older than the strip the three
// are now expressed as, and it survived it.
//
// The exception worth keeping is the re-upload guard: choosing the image that
// is already stored resolves through `onCancel`, not `onConfirm`, so the
// backend never re-copies identical bytes under the same name. It looks like a
// bug from the outside ("Save cancelled?"), which is exactly why it is pinned.
const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
// Kobalte installs its outside-pointerdown listener from a `setTimeout(0)`, so a
// press fired before this yield lands on nobody.
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

type Props = Parameters<typeof ProjectIconDialog>[0];

function open(props: Partial<Omit<Props, "onConfirm" | "onCancel">> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const onPickFile = vi.fn(() => Promise.resolve<string | null>("/tmp/logo.png"));
  render(() => (
    <ProjectIconDialog
      projectName="tori"
      seed="/Users/x/Projects/tori"
      icon={null}
      iconFile={null}
      favicon={null}
      busy={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
      onPickFile={onPickFile}
      {...props}
    />
  ));
  const search = () => screen.getByLabelText("Search icons") as HTMLInputElement;
  const tiles = () =>
    Array.from(
      screen.getByRole("group", { name: "Project icon" }).querySelectorAll("button"),
    );
  const mode = (name: string) => screen.getByRole("button", { name });
  // The grid rests on a short random shelf, so a named glyph is reached the way
  // a user reaches one: through the field beside it.
  const pick = (name: string) => {
    fireEvent.input(search(), { target: { value: name } });
    fireEvent.click(tiles().find((b) => b.getAttribute("aria-label") === name)!);
  };
  const dropzone = () => screen.getByRole("button", { name: /SVG, PNG or ICO/ });
  const panel = () => screen.getByRole("dialog");
  return { onConfirm, onCancel, onPickFile, search, tiles, mode, pick, dropzone, panel };
}

const save = (label = "Save") =>
  screen.getByRole("button", { name: label }) as HTMLButtonElement;

describe("ProjectIconDialog", () => {
  describe("contract", () => {
    it("names the project it is dressing", () => {
      open();

      expect(screen.getByText("Icon for “tori”")).toBeTruthy();
    });

    it("says what the automatic option will actually show", () => {
      open();

      expect(screen.getByText("Derived from the folder")).toBeTruthy();
    });

    it("says the automatic option is the favicon when there is one", () => {
      open({ favicon: "/tmp/favicon.ico" });

      expect(screen.getByText("The project's own favicon")).toBeTruthy();
    });

    it("starts on automatic when nothing is stored", () => {
      const { mode } = open();

      expect(mode("Automatic").getAttribute("aria-pressed")).toBe("true");
    });

    it("starts on the stored glyph", () => {
      const { tiles, mode } = open({ icon: "Rocket" });

      expect(mode("Pick an icon").getAttribute("aria-pressed")).toBe("true");
      expect(
        tiles().some(
          (b) =>
            b.getAttribute("aria-label") === "Rocket" &&
            b.getAttribute("aria-pressed") === "true",
        ),
      ).toBe(true);
    });

    it("starts on the stored image, previewing it", () => {
      const { mode } = open({ iconFile: "/store/icon.png" });

      expect(mode("Upload").getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByText("Uploaded image")).toBeTruthy();
      expect(document.querySelector("img")?.getAttribute("src")).toBe("asset:///store/icon.png");
    });

    it("saves automatic as an empty choice", () => {
      const { onConfirm, mode } = open({ icon: "Rocket" });

      fireEvent.click(mode("Automatic"));
      fireEvent.click(save());

      expect(onConfirm).toHaveBeenCalledWith({});
    });

    it("saves a picked glyph by name", () => {
      const { onConfirm, mode, pick } = open();

      fireEvent.click(mode("Pick an icon"));
      pick("Rocket");
      fireEvent.click(save());

      expect(onConfirm).toHaveBeenCalledWith({ icon: "Rocket" });
    });

    it("un-chooses the glyph when an image is uploaded", async () => {
      const { onConfirm, mode, pick, dropzone } = open();

      fireEvent.click(mode("Pick an icon"));
      pick("Rocket");
      fireEvent.click(mode("Upload"));
      fireEvent.click(dropzone());
      await waitFor(() => expect(screen.getByText("logo.png")).toBeTruthy());
      fireEvent.click(save());

      expect(onConfirm).toHaveBeenCalledWith({ file: "/tmp/logo.png" });
    });

    it("keeps the glyph while a dismissed file picker leaves upload empty", async () => {
      const onPickFile = vi.fn(() => Promise.resolve<string | null>(null));
      const { onConfirm, mode, dropzone } = open({ icon: "Rocket", onPickFile });

      fireEvent.click(mode("Upload"));
      fireEvent.click(dropzone());
      await waitFor(() => expect(onPickFile).toHaveBeenCalledTimes(1));
      // Nothing to save in this mode, and the glyph is still there to go back to.
      expect(save().disabled).toBe(true);

      fireEvent.click(mode("Pick an icon"));
      fireEvent.click(save());

      expect(onConfirm).toHaveBeenCalledWith({ icon: "Rocket" });
    });

    it("does not re-upload the image it already has", () => {
      const { onConfirm, onCancel } = open({ iconFile: "/store/icon.png" });

      fireEvent.click(save());

      expect(onConfirm).not.toHaveBeenCalled();
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("asks the host for the file, once, however fast the zone is hit", async () => {
      const { onPickFile, mode, dropzone } = open();

      fireEvent.click(mode("Upload"));
      fireEvent.click(dropzone());
      fireEvent.click(dropzone());
      await waitFor(() => expect(screen.getByText("logo.png")).toBeTruthy());

      expect(onPickFile).toHaveBeenCalledTimes(1);
    });

    it("states the upload limits in the zone they apply to", () => {
      const { mode } = open();

      expect(screen.queryByText(/SVG, PNG or ICO/)).toBeNull();

      fireEvent.click(mode("Upload"));

      expect(screen.getByText("SVG, PNG or ICO, up to 2 MB, square works best")).toBeTruthy();
    });

    it("filters the glyph grid", () => {
      const { search, tiles, mode } = open();

      fireEvent.click(mode("Pick an icon"));
      const shelf = tiles().length;
      fireEvent.input(search(), { target: { value: "rocket" } });

      expect(tiles().length).toBeLessThan(shelf);
      expect(tiles()[0].getAttribute("aria-label")).toBe("Rocket");
    });

    it("confirms on Enter", () => {
      const { onConfirm, panel } = open();

      fireEvent.keyDown(panel(), { key: "Enter" });

      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    // `IconGrid` stops both activation keys at the group, so Enter on a tile
    // picks that tile and saving needs focus outside the picker. Before the
    // picker moved onto `IconGrid` the dialog's own `onKeyDown` saw every
    // Enter, including one aimed at a tile: it cancelled the button's
    // activation and saved, so the grid had no keyboard activation at all.
    it("picks a tile on Enter rather than saving from inside the picker", () => {
      const { onConfirm, tiles, mode, panel } = open();

      fireEvent.click(mode("Pick an icon"));
      fireEvent.keyDown(tiles()[0], { key: "Enter" });

      expect(onConfirm).not.toHaveBeenCalled();
      expect(tiles()[0].getAttribute("aria-pressed")).toBe("true");

      // The panel still saves, so the change is scoped to the picker.
      fireEvent.keyDown(panel(), { key: "Enter" });
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it("refuses to save a mode that has nothing in it", () => {
      const { onConfirm, mode, panel } = open();

      fireEvent.click(mode("Pick an icon"));

      expect(save().disabled).toBe(true);
      fireEvent.keyDown(panel(), { key: "Enter" });
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("ignores Enter while it is already working", () => {
      const { onConfirm, panel } = open({ busy: true });

      fireEvent.keyDown(panel(), { key: "Enter" });

      expect(onConfirm).not.toHaveBeenCalled();
      expect(save("Working…").disabled).toBe(true);
    });

    it("cancels on Escape", () => {
      const { onCancel, panel } = open();

      fireEvent.keyDown(panel(), { key: "Escape" });

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("cancels on the Cancel button", () => {
      const { onCancel } = open();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("focuses the glyph search when it opens on a picked icon", async () => {
      const { search } = open({ icon: "Rocket" });
      await frame();

      expect(document.activeElement).toBe(search());
    });

    it("has no accessibility violations", async () => {
      open({ favicon: "/tmp/favicon.ico" });

      await expectNoAxeViolations(document.body);
    });

    it("has no accessibility violations in the upload mode", async () => {
      const { mode } = open();

      fireEvent.click(mode("Upload"));

      await expectNoAxeViolations(document.body);
    });
  });

  describe("shape", () => {
    // Rewritten at migration time: dismissal was a `mousedown` on a real
    // backdrop element and is now Kobalte's outside `pointerdown`, from a
    // listener it installs in a `setTimeout(0)`.
    it("cancels on a pointer down outside the panel", async () => {
      const { onCancel } = open();
      await macrotask();

      fireEvent.pointerDown(document.body);

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("stays open on a pointer down inside the panel", async () => {
      const { onCancel } = open();
      await macrotask();

      fireEvent.pointerDown(screen.getByRole("dialog"));

      expect(onCancel).not.toHaveBeenCalled();
    });
  });
});
