import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import NewProjectDialog from "./NewProjectDialog";

// Characterization test for the "new thing under a space" dialog, written
// against the hand-rolled implementation and kept green across the migration
// onto `components/Dialog` (#99). See `ConfirmDialog.test.tsx` for why the file
// splits into a **contract** block that must survive the swap unchanged and a
// **shape** block that is knowingly rewritten with it.
//
// The delicate part is the name field, which is auto-filled from the URL only
// until somebody types in it. Clobbering a hand-typed folder name on the next
// URL keystroke is the failure this pins, and it is invisible in review because
// both behaviors look like "the name updates".
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
// Kobalte's focus scope and its dismiss layer both install from a
// `setTimeout(0)`, so anything asserting on them has to yield a macrotask.
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

type NewProps = Parameters<typeof NewProjectDialog>[0];

function open(props: Partial<Omit<NewProps, "onConfirm" | "onCancel">> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(() => <NewProjectDialog spaceName="work" busy={false} onConfirm={onConfirm} onCancel={onCancel} {...props} />);
  const mode = (name: string) => screen.getByRole("button", { name });
  const name = () =>
    (screen.queryByPlaceholderText("folder name") ??
      screen.getByPlaceholderText("defaults from the URL")) as HTMLInputElement;
  const url = () => screen.getByPlaceholderText("https://github.com/org/repo.git") as HTMLInputElement;
  return { onConfirm, onCancel, mode, name, url };
}

const create = () => screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;

describe("NewProjectDialog", () => {
  describe("contract", () => {
    it("names the space it is about to create in", () => {
      open();

      expect(screen.getByText("New in “work”")).toBeTruthy();
    });

    it("focuses the name field", async () => {
      const { name } = open();
      await frame();

      expect(document.activeElement).toBe(name());
    });

    it("starts on a plain folder, with no URL to give", () => {
      const { mode } = open();

      expect(mode("Folder").getAttribute("aria-pressed")).toBe("true");
      expect(screen.queryByPlaceholderText("https://github.com/org/repo.git")).toBeNull();
      expect(screen.getByText("A plain folder, no git. Nothing is cloned.")).toBeTruthy();
    });

    it("asks for a URL once the mode needs one", () => {
      const { mode, url } = open();

      fireEvent.click(mode("Clone"));

      expect(url()).toBeTruthy();
      expect(screen.getByText("Clones a git repository into a new folder inside this space.")).toBeTruthy();
    });

    it("describes the bare + worktree layout", () => {
      const { mode } = open();

      fireEvent.click(mode("Bare + worktree"));

      expect(
        screen.getByText("A .bare repo plus one initial worktree. Add more branches later as their own folders."),
      ).toBeTruthy();
    });

    it("creates a folder from a trimmed name", () => {
      const { onConfirm, name } = open();

      fireEvent.input(name(), { target: { value: "  notes  " } });
      fireEvent.click(create());

      expect(onConfirm).toHaveBeenCalledWith({ mode: "folder", name: "notes", url: "" });
    });

    it("fills the folder name from the URL", () => {
      const { onConfirm, mode, name, url } = open();

      fireEvent.click(mode("Clone"));
      fireEvent.input(url(), { target: { value: "https://github.com/skarif2/tori.git" } });

      expect(name().value).toBe("tori");

      fireEvent.click(create());

      expect(onConfirm).toHaveBeenCalledWith({
        mode: "clone",
        name: "tori",
        url: "https://github.com/skarif2/tori.git",
      });
    });

    it("stops filling the name once it has been typed in by hand", () => {
      const { mode, name, url } = open();

      fireEvent.click(mode("Clone"));
      fireEvent.input(name(), { target: { value: "my-copy" } });
      fireEvent.input(url(), { target: { value: "https://github.com/skarif2/tori.git" } });

      expect(name().value).toBe("my-copy");
    });

    it("will not create without a name", () => {
      const { onConfirm } = open();

      expect(create().disabled).toBe(true);

      fireEvent.click(create());

      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("will not clone without a URL", () => {
      const { onConfirm, mode, name } = open();

      fireEvent.click(mode("Clone"));
      fireEvent.input(name(), { target: { value: "tori" } });

      expect(create().disabled).toBe(true);

      fireEvent.click(create());

      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("confirms on Enter from inside the dialog", () => {
      const { onConfirm, name } = open();

      fireEvent.input(name(), { target: { value: "notes" } });
      fireEvent.keyDown(name(), { key: "Enter" });

      expect(onConfirm).toHaveBeenCalledWith({ mode: "folder", name: "notes", url: "" });
    });

    it("ignores Enter while the work is already running", () => {
      const { onConfirm, name } = open({ busy: true });

      fireEvent.input(name(), { target: { value: "notes" } });
      fireEvent.keyDown(name(), { key: "Enter" });

      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("says it is working and blocks a second submit", () => {
      const { onConfirm, name } = open({ busy: true });

      fireEvent.input(name(), { target: { value: "notes" } });
      const submit = screen.getByRole("button", { name: "Working…" }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);

      fireEvent.click(submit);

      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("cancels on Escape", () => {
      const { onCancel, name } = open();

      fireEvent.keyDown(name(), { key: "Escape" });

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("cancels when Cancel is clicked", () => {
      const { onCancel } = open();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe("shape", () => {
    it("cancels on a pointer down outside the panel", async () => {
      const { onCancel } = open();
      // Kobalte installs its outside-pointerdown listener from a
      // `setTimeout(0)`, so a press fired before this yield lands on nobody.
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

  // Scoped to `document.body`: the panel is portalled out of the render
  // container, and modality is expressed by aria-hiding its siblings.
  describe("accessibility", () => {
    it("has no violations", async () => {
      open();

      await expectNoAxeViolations(document.body);
    });

    it("has no violations with the URL field showing", async () => {
      const { mode } = open();

      fireEvent.click(mode("Clone"));

      await expectNoAxeViolations(document.body);
    });
  });
});
