import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import styles from "./Dialogs.module.css";
import CreatePrDialog from "./CreatePrDialog";

// Characterization test for the in-app "open a pull request" form, written
// against the hand-rolled implementation and kept green across the migration
// onto `components/Dialog` (#99). See `ConfirmDialog.test.tsx` for why the file
// splits into a **contract** block that must survive the swap unchanged and a
// **shape** block that is knowingly rewritten with it.
//
// Two things here are deliberate absences rather than features, and both are
// easy to "fix" during a shell swap:
//
//   * **Enter does not submit.** The body is a textarea where newlines are the
//     point, and a primary action on Enter would open a PR mid-sentence.
//   * **The busy guard is route-dependent.** A pointer press outside does not
//     dismiss an in-flight submit, but Escape still does. The user who is
//     staring at "Opening…" and wants out keeps a way out; a stray click
//     behind the panel does not throw the form away.
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
// Kobalte's focus scope and its dismiss layer both install from a
// `setTimeout(0)`, so anything asserting on them has to yield a macrotask.
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

type PrProps = Parameters<typeof CreatePrDialog>[0];
type Handlers = "onTitleChange" | "onBodyChange" | "onBaseChange" | "onDraft" | "onConfirm" | "onCancel";

function open(props: Partial<Omit<PrProps, Handlers>> = {}) {
  const on = {
    onTitleChange: vi.fn(),
    onBodyChange: vi.fn(),
    onBaseChange: vi.fn(),
    onDraft: vi.fn(),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };
  render(() => (
    <CreatePrDialog
      head="wave-3"
      base="main"
      busy={false}
      drafting={false}
      draftDisabledReason={null}
      title="Add the review panel"
      body="Some prose."
      {...on}
      {...props}
    />
  ));
  return {
    ...on,
    title: screen.getByPlaceholderText("What this branch does") as HTMLInputElement,
    body: screen.getByPlaceholderText("Optional") as HTMLTextAreaElement,
    // The title and the base are the only two `input`s; the description is a
    // textarea that shares the class. Narrowed to the tag so adding a field
    // above the base does not silently retarget this at a different one.
    base: document.querySelectorAll<HTMLInputElement>(`input.${styles.modalInput}`)[1],
    draft: screen.getByRole("checkbox") as HTMLInputElement,
  };
}

const submit = () =>
  (screen.queryByRole("button", { name: "Open pull request" }) ??
    screen.getByRole("button", { name: "Opening…" })) as HTMLButtonElement;

describe("CreatePrDialog", () => {
  describe("contract", () => {
    it("says what it is about to open, and against what", () => {
      open();

      expect(screen.getByText("Open a pull request")).toBeTruthy();
      expect(screen.getByText("wave-3 into main")).toBeTruthy();
    });

    it("focuses the title field", async () => {
      const { title } = open();
      await frame();

      expect(document.activeElement).toBe(title);
    });

    it("shows the fields it was given", () => {
      const { title, body, base } = open();

      expect(title.value).toBe("Add the review panel");
      expect(body.value).toBe("Some prose.");
      expect(base.value).toBe("main");
    });

    it("relays every edit to its owner", () => {
      const { onTitleChange, onBodyChange, onBaseChange, title, body, base } = open();

      fireEvent.input(title, { target: { value: "Add the PR form" } });
      fireEvent.input(body, { target: { value: "More prose." } });
      fireEvent.input(base, { target: { value: "release" } });

      expect(onTitleChange).toHaveBeenCalledWith("Add the PR form");
      expect(onBodyChange).toHaveBeenCalledWith("More prose.");
      expect(onBaseChange).toHaveBeenCalledWith("release");
    });

    it("does not submit on Enter, because the body is prose", () => {
      const { onConfirm, title, body } = open();

      fireEvent.keyDown(title, { key: "Enter" });
      fireEvent.keyDown(body, { key: "Enter" });

      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("opens the pull request when the primary action is clicked", () => {
      const { onConfirm } = open();

      fireEvent.click(submit());

      expect(onConfirm).toHaveBeenCalledWith({ draft: false });
    });

    it("carries the draft choice", () => {
      const { onConfirm, draft } = open();

      fireEvent.change(draft, { target: { checked: true } });
      fireEvent.click(submit());

      expect(onConfirm).toHaveBeenCalledWith({ draft: true });
    });

    it("says why it cannot be submitted, rather than disabling in silence", () => {
      const { onConfirm } = open({ title: "  " });

      expect(screen.getByText("A title is required")).toBeTruthy();
      expect(submit().disabled).toBe(true);

      fireEvent.click(submit());

      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("refuses a base that is the branch itself", () => {
      open({ base: "wave-3" });

      expect(screen.getByText("The base and the branch are the same")).toBeTruthy();
      expect(submit().disabled).toBe(true);
    });

    it("asks the agent for a draft", () => {
      const { onDraft } = open();

      fireEvent.click(screen.getByRole("button", { name: "Ask agent to draft" }));

      expect(onDraft).toHaveBeenCalledTimes(1);
    });

    it("explains a draft button it had to disable", () => {
      const { onDraft } = open({ draftDisabledReason: "No session can take a request" });

      const ask = screen.getByRole("button", { name: "Ask agent to draft" }) as HTMLButtonElement;
      expect(ask.disabled).toBe(true);
      expect(ask.title).toBe("No session can take a request");

      fireEvent.click(ask);

      expect(onDraft).not.toHaveBeenCalled();
    });

    it("says the agent is drafting", () => {
      open({ drafting: true });

      expect((screen.getByRole("button", { name: "Asking…" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });

    it("says it is opening, and blocks a second submit", () => {
      const { onConfirm } = open({ busy: true });

      const opening = submit();
      expect(opening.disabled).toBe(true);

      fireEvent.click(opening);

      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("keeps Escape working while the submit is in flight", () => {
      const { onCancel, title } = open({ busy: true });

      fireEvent.keyDown(title, { key: "Escape" });

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("cancels on Escape", () => {
      const { onCancel, onConfirm, title } = open();

      fireEvent.keyDown(title, { key: "Escape" });

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("cancels when Cancel is clicked", () => {
      const { onCancel } = open();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("blocks Cancel while the submit is in flight", () => {
      const { onCancel } = open({ busy: true });

      const cancel = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
      expect(cancel.disabled).toBe(true);

      fireEvent.click(cancel);

      expect(onCancel).not.toHaveBeenCalled();
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

    it("holds on to an in-flight submit when the pointer lands outside", async () => {
      const { onCancel } = open({ busy: true });
      await macrotask();

      fireEvent.pointerDown(document.body);

      expect(onCancel).not.toHaveBeenCalled();
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

    it("has no violations while blocked and mid-submit", async () => {
      open({ busy: true, draftDisabledReason: "No session can take a request" });

      await expectNoAxeViolations(document.body);
    });
  });
});
