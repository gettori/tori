import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import styles from "./Dialogs.module.css";

// `convertFileSrc` turns a path into an asset URL the webview can load, and it
// reads Tauri's injected internals to do it. There is no host here, so it is
// stubbed to something recognisable: what the assertions care about is that the
// chosen path reaches the preview at all, not what the real protocol spells.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

const { default: ProjectIconDialog } = await import("./ProjectIconDialog");

// Characterization test for the project icon picker, written against the
// hand-rolled implementation and kept green across the migration onto
// `components/Dialog` (#100). Contract / shape split as in
// `ConfirmDialog.test.tsx`.
//
// The behavior that matters is that the three ways to have an icon are one
// selection, not a stack of fallbacks: automatic, an uploaded image, and a
// glyph from the picker each un-choose the other two. The payload says which,
// by which key is present, so the assertions read the payload rather than the
// highlight wherever they can.
//
// The exception worth keeping is the re-upload guard: choosing the image that
// is already stored resolves through `onCancel`, not `onConfirm`, so the
// backend never re-copies identical bytes under the same name. It looks like a
// bug from the outside ("Save cancelled?"), which is exactly why it is pinned.
//
// **Accessibility baseline, measured before any migration edit:** zero
// violations, zero incomplete.
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
      projectName="sway"
      seed="/Users/x/Projects/sway"
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
  const modes = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>(`.${styles.iconMode}`));
  return { onConfirm, onCancel, onPickFile, search, tiles, modes };
}

const save = (label = "Save") =>
  screen.getByRole("button", { name: label }) as HTMLButtonElement;

describe("ProjectIconDialog", () => {
  describe("contract", () => {
    it("names the project it is dressing", () => {
      open();

      expect(screen.getByText("Icon for “sway”")).toBeTruthy();
    });

    it("calls the automatic option what it will actually show", () => {
      open();

      expect(screen.getByText("Automatic")).toBeTruthy();
    });

    it("says the automatic option is the favicon when there is one", () => {
      open({ favicon: "/tmp/favicon.ico" });

      expect(screen.getByText("Project favicon")).toBeTruthy();
    });

    it("starts on automatic when nothing is stored", () => {
      const { modes } = open();

      expect(modes()[0].getAttribute("aria-pressed")).toBe("true");
    });

    it("starts on the stored glyph", () => {
      const { tiles } = open({ icon: "Rocket" });

      expect(tiles().some((b) => b.getAttribute("aria-label") === "Rocket" && b.getAttribute("aria-pressed") === "true")).toBe(true);
    });

    it("starts on the stored image, previewing it", () => {
      const { modes } = open({ iconFile: "/store/icon.png" });

      expect(modes()[1].getAttribute("aria-pressed")).toBe("true");
      expect(modes()[1].querySelector("img")?.getAttribute("src")).toBe("asset:///store/icon.png");
      expect(screen.getByText("Change image…")).toBeTruthy();
    });

    it("saves automatic as an empty choice", () => {
      const { onConfirm } = open({ icon: "Rocket" });

      fireEvent.click(screen.getByText("Automatic"));
      fireEvent.click(save());

      expect(onConfirm).toHaveBeenCalledWith({});
    });

    it("saves a picked glyph by name", () => {
      const { onConfirm, tiles } = open();

      fireEvent.click(tiles().find((b) => b.getAttribute("aria-label") === "Rocket")!);
      fireEvent.click(save());

      expect(onConfirm).toHaveBeenCalledWith({ icon: "Rocket" });
    });

    it("un-chooses the glyph when an image is uploaded", async () => {
      const { onConfirm, tiles, modes } = open();

      fireEvent.click(tiles().find((b) => b.getAttribute("aria-label") === "Rocket")!);
      fireEvent.click(modes()[1]);
      await waitFor(() => expect(screen.getByText("Change image…")).toBeTruthy());
      fireEvent.click(save());

      expect(onConfirm).toHaveBeenCalledWith({ file: "/tmp/logo.png" });
    });

    it("keeps the old choice when the file picker is dismissed", async () => {
      const onPickFile = vi.fn(() => Promise.resolve<string | null>(null));
      const { onConfirm, modes } = open({ icon: "Rocket", onPickFile });

      fireEvent.click(modes()[1]);
      await waitFor(() => expect(onPickFile).toHaveBeenCalledTimes(1));
      fireEvent.click(save());

      expect(onConfirm).toHaveBeenCalledWith({ icon: "Rocket" });
    });

    it("does not re-upload the image it already has", () => {
      const { onConfirm, onCancel } = open({ iconFile: "/store/icon.png" });

      fireEvent.click(save());

      expect(onConfirm).not.toHaveBeenCalled();
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("asks the host for the file, once, however fast the button is hit", async () => {
      const { onPickFile, modes } = open();

      fireEvent.click(modes()[1]);
      fireEvent.click(modes()[1]);
      await waitFor(() => expect(screen.getByText("Change image…")).toBeTruthy());

      expect(onPickFile).toHaveBeenCalledTimes(1);
    });

    it("states the upload limits rather than failing on them later", () => {
      open();

      expect(screen.getByText("SVG, PNG or ICO, up to 2 MB.")).toBeTruthy();
    });

    it("filters the glyph grid", () => {
      const { search, tiles } = open();

      const all = tiles().length;
      fireEvent.input(search(), { target: { value: "rocket" } });

      expect(tiles().length).toBeLessThan(all);
      expect(tiles()[0].getAttribute("aria-label")).toBe("Rocket");
    });

    it("confirms on Enter", () => {
      const { onConfirm, search } = open();

      fireEvent.keyDown(search(), { key: "Enter" });

      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    // Added with #109, and a deliberate change of behaviour rather than a
    // characterization of the old one. Before the picker moved onto `IconGrid`
    // the dialog's own `onKeyDown` saw every Enter, including one aimed at a
    // tile: it cancelled the button's activation and saved, so the grid had no
    // keyboard activation at all. `IconGrid` stops both activation keys at the
    // group, so Enter on a tile picks that tile and saving needs focus outside
    // the picker.
    it("picks a tile on Enter rather than saving from inside the picker", () => {
      const { onConfirm, tiles, search } = open();

      fireEvent.keyDown(tiles()[0], { key: "Enter" });

      expect(onConfirm).not.toHaveBeenCalled();
      expect(tiles()[0].getAttribute("aria-pressed")).toBe("true");

      // The search field still saves, so the change is scoped to the picker.
      fireEvent.keyDown(search(), { key: "Enter" });
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it("ignores Enter while it is already working", () => {
      const { onConfirm, search } = open({ busy: true });

      fireEvent.keyDown(search(), { key: "Enter" });

      expect(onConfirm).not.toHaveBeenCalled();
      expect(save("Working…").disabled).toBe(true);
    });

    it("cancels on Escape", () => {
      const { onCancel, search } = open();

      fireEvent.keyDown(search(), { key: "Escape" });

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("cancels on the Cancel button", () => {
      const { onCancel } = open();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("focuses the glyph search", async () => {
      const { search } = open();
      await frame();

      expect(document.activeElement).toBe(search());
    });

    it("has no accessibility violations", async () => {
      open({ favicon: "/tmp/favicon.ico" });

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
