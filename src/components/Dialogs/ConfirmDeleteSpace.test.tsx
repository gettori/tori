import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import ConfirmDeleteSpace from "./ConfirmDeleteSpace";

// Characterization test for the space deletion, written against the hand-rolled
// implementation and kept green across the migration onto `components/Dialog`
// (#100). Contract / shape split as in `ConfirmDialog.test.tsx`.
//
// The gate is the whole point of this dialog: Delete stays disabled until the
// space name is typed exactly, and Enter is answered only when it matches. Note
// where that Enter handler lives, because it is not where the other dialogs in
// this set keep theirs: on the *input*, not on the panel. A migration that
// hoisted it to the panel would widen the gate to the whole dialog, so the
// assertions below fire Enter on the input deliberately, and one of them fires
// it elsewhere to pin that nothing answers there.
//
// **Accessibility, now clean.** The phase-1 baseline carried exactly one
// violation, `label` on the confirm input: introduced by a `div.label`
// rather than a `<label>`, with no `aria-label` and no placeholder to fall back
// on. It is now named by `aria-labelledby` pointing at that same visible
// "Type <name> to confirm" line, so the announcement and the instruction on
// screen are the same words, and the rule override is gone.
const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
// Kobalte installs its outside-pointerdown listener from a `setTimeout(0)`, so a
// press fired before this yield lands on nobody.
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

type Props = Parameters<typeof ConfirmDeleteSpace>[0];

function open(props: Partial<Omit<Props, "onConfirm" | "onCancel">> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(() => (
    <ConfirmDeleteSpace
      spaceName="work"
      kind="space"
      path="~/code/work"
      entries={[]}
      loading={false}
      runningCount={0}
      sizeBytes={null}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />
  ));
  // Asked through the accessibility tree, not through the class: the field is
  // the dialog's only textbox either side of the swap, and it stays the only
  // one after phase 2 gives it a real name (see the header).
  const input = () => screen.getByRole("textbox") as HTMLInputElement;
  // A stat panel by its caps label, read whole: the label and the value are two
  // lines of one box, and the value alone ("1", "…") is too common a string to
  // find on its own.
  const stat = (label: string) => screen.getByText(label).parentElement!.textContent ?? "";
  return { onConfirm, onCancel, input, stat };
}

const del = (name = "Delete space") =>
  screen.getByRole("button", { name }) as HTMLButtonElement;

describe("ConfirmDeleteSpace", () => {
  describe("contract", () => {
    it("names the space it is about to delete", () => {
      open();

      expect(screen.getByText("Delete space “work”?")).toBeTruthy();
      // The consequence names the folder, so the sentence is split across the
      // mono path span and cannot be found as one text node.
      expect(screen.getByText("~/code/work")).toBeTruthy();
      expect(
        screen.getByText(/and everything below it from disk\. It cannot be undone\./),
      ).toBeTruthy();
    });

    it("takes the caller's wording when the target is not a space", () => {
      open({ title: "Delete folder “notes”?", confirmLabel: "Delete folder" });

      expect(screen.getByText("Delete folder “notes”?")).toBeTruthy();
      expect(del("Delete folder")).toBeTruthy();
    });

    it("counts the agents running under it", () => {
      const { stat } = open({ runningCount: 1 });

      expect(stat("Agents running")).toContain("1");
    });

    it("says the size is still being counted", () => {
      const { stat } = open();

      expect(stat("On disk")).toContain("…");
    });

    it("reports the size once it is in", () => {
      open({ sizeBytes: 1024 });

      expect(screen.getByText("1 KB")).toBeTruthy();
    });

    // The only unrecoverable part of the blast radius, so it is counted in its
    // own panel rather than left to be inferred from the list.
    it("counts the repos holding unpushed work", () => {
      const { stat } = open({
        entries: [
          { name: "api", kind: "repo", dirty: false, unpushed: true },
          { name: "web", kind: "repo", dirty: true, unpushed: false },
        ],
      });

      expect(stat("Unpushed")).toContain("1 repo");
    });

    it("lists the whole blast radius, not only the repos", () => {
      open({
        entries: [
          { name: "api", kind: "repo", dirty: true, unpushed: false },
          { name: "notes", kind: "folder", dirty: false, unpushed: false },
          { name: "todo.md", kind: "file", dirty: false, unpushed: false },
        ],
      });

      expect(screen.getByText("api")).toBeTruthy();
      expect(screen.getByText("uncommitted")).toBeTruthy();
      expect(screen.getByText("notes")).toBeTruthy();
      expect(screen.getByText("todo.md")).toBeTruthy();
    });

    // What cannot be got back is read first, whatever order the preview
    // enumerated the folder in.
    it("sorts the rows holding unpushed work to the top", () => {
      open({
        entries: [
          { name: "api", kind: "repo", dirty: false, unpushed: false },
          { name: "notes", kind: "folder", dirty: false, unpushed: false },
          { name: "web", kind: "repo", dirty: false, unpushed: true },
        ],
      });

      const names = screen.getAllByText(/^(api|notes|web)$/).map((el) => el.textContent);
      expect(names[0]).toBe("web");
    });

    it("says so when there is nothing below it", () => {
      open();

      expect(screen.getByText("Nothing inside it")).toBeTruthy();
    });

    it("holds the repo flags back until they are known", () => {
      open({
        loading: true,
        entries: [{ name: "api", kind: "repo", dirty: true, unpushed: true }],
      });

      expect(screen.getByText("checking…")).toBeTruthy();
      expect(screen.queryByText("uncommitted")).toBeNull();
    });

    it("keeps Delete disabled until the name is typed exactly", () => {
      const { input } = open();

      expect(del().disabled).toBe(true);

      fireEvent.input(input(), { target: { value: "wor" } });
      expect(del().disabled).toBe(true);

      fireEvent.input(input(), { target: { value: "Work" } });
      expect(del().disabled).toBe(true);

      fireEvent.input(input(), { target: { value: "work" } });
      expect(del().disabled).toBe(false);
    });

    it("deletes on Enter once the name matches", () => {
      const { onConfirm, input } = open();

      fireEvent.input(input(), { target: { value: "work" } });
      fireEvent.keyDown(input(), { key: "Enter" });

      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it("ignores Enter while the name does not match", () => {
      const { onConfirm, input } = open();

      fireEvent.input(input(), { target: { value: "wor" } });
      fireEvent.keyDown(input(), { key: "Enter" });

      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("answers Enter only from the input, not from anywhere in the dialog", () => {
      const { onConfirm, input } = open();

      fireEvent.input(input(), { target: { value: "work" } });
      fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Enter" });

      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("cancels on Escape", () => {
      const { onCancel, input } = open();

      fireEvent.keyDown(input(), { key: "Escape" });

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("cancels on the Cancel button", () => {
      const { onCancel } = open();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("focuses the confirmation field", async () => {
      const { input } = open();
      await frame();

      expect(document.activeElement).toBe(input());
    });

    it("has no accessibility violations", async () => {
      open({
        runningCount: 2,
        sizeBytes: 4096,
        entries: [{ name: "api", kind: "repo", dirty: true, unpushed: true }],
      });

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
