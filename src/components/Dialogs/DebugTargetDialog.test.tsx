import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import styles from "./Dialogs.module.css";
import DebugTargetDialog from "./DebugTargetDialog";

// Characterization test for the debug-target picker, written against the
// hand-rolled implementation and kept green across the migration onto
// `components/Dialog` (#100). Contract / shape split as in
// `ConfirmDialog.test.tsx`.
//
// This is the mode-picker shape from `lesson_menu_items_into_mode_picker_dialog`:
// three things "debug" can mean, one dialog, only the field the mode needs on
// screen, and Start gated per mode. So the contract is not one gate but three,
// each with its own reason for being unavailable, and the reason is *shown*
// rather than left as a dead button. That is what these assertions pin.
//
// The focus behavior carries the case that made `Dialog` grow an `onKeyDown`
// (#100 phase 1): in file mode this dialog names no focus target at all, since
// `first` is only ever assigned by the script select or the port input. After
// the migration that leaves focus on the panel itself, where no control answers
// Enter, which is exactly the seam the wrapper's key prop exists for.
//
// **Accessibility baseline, measured before any migration edit.** In file and
// attach modes axe is clean. In script mode it reports one violation,
// `select-name`: the script `<select>` is introduced by a `div.modalLabel`
// rather than a `<label>` and has no `aria-label`. The port input escapes the
// same fate only because it carries a `placeholder`, which axe accepts as an
// accessible name. Phase 2 of #100 labels the select and drops the override.
const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

type Props = Parameters<typeof DebugTargetDialog>[0];

function open(props: Partial<Omit<Props, "onConfirm" | "onCancel">> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(() => (
    <DebugTargetDialog
      kind="file"
      filePath={null}
      scripts={[]}
      port={9229}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />
  ));
  // Asked through the accessibility tree, not through the class. Each mode
  // renders at most one of these, and they keep their roles after phase 2 names
  // the select, so these queries outlive both changes.
  const mode = (name: string) => screen.getByRole("radio", { name });
  const port = () => screen.getByRole("textbox") as HTMLInputElement;
  const script = () => screen.getByRole("combobox") as HTMLSelectElement;
  return { onConfirm, onCancel, mode, port, script };
}

const start = () => screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;

describe("DebugTargetDialog", () => {
  describe("contract", () => {
    it("opens on the mode the caller asked for", () => {
      const { mode } = open({ kind: "attach" });

      expect(mode("Attach").getAttribute("aria-checked")).toBe("true");
    });

    it("offers all three meanings of debug side by side", () => {
      const { mode } = open();

      expect(mode("This file")).toBeTruthy();
      expect(mode("Package script")).toBeTruthy();
      expect(mode("Attach")).toBeTruthy();
    });

    it("says what it would run, in this file mode", () => {
      open({ filePath: "/tmp/app.ts" });

      expect(
        screen.getByText("Runs /tmp/app.ts under node, stopping on your breakpoints."),
      ).toBeTruthy();
    });

    it("blocks this file mode with a reason when nothing is open", () => {
      open();

      expect(screen.getByText("No file is open.")).toBeTruthy();
      expect(screen.getByText("Open a file to debug it.")).toBeTruthy();
      expect(start().disabled).toBe(true);
    });

    it("starts a file target", () => {
      const { onConfirm } = open({ filePath: "/tmp/app.ts" });

      fireEvent.click(start());

      expect(onConfirm).toHaveBeenCalledWith({ kind: "file", path: "/tmp/app.ts" });
    });

    it("blocks script mode with a reason when the project declares none", () => {
      const { mode } = open();

      fireEvent.click(mode("Package script"));

      expect(screen.getByText("No scripts in this project's package.json.")).toBeTruthy();
      expect(screen.getByText("This project declares no package scripts.")).toBeTruthy();
      expect(start().disabled).toBe(true);
    });

    it("starts the first script by default, in declaration order", () => {
      const { onConfirm } = open({ kind: "script", scripts: ["dev", "test"] });

      fireEvent.click(start());

      expect(onConfirm).toHaveBeenCalledWith({ kind: "script", script: "dev" });
    });

    it("starts whichever script is picked", () => {
      const { onConfirm, script } = open({ kind: "script", scripts: ["dev", "test"] });

      fireEvent.change(script(), { target: { value: "test" } });
      fireEvent.click(start());

      expect(onConfirm).toHaveBeenCalledWith({ kind: "script", script: "test" });
    });

    it("offers the workspace's last port for an attach", () => {
      const { port } = open({ kind: "attach", port: 9230 });

      expect(port().value).toBe("9230");
    });

    it("starts an attach on a valid port, as a number", () => {
      const { onConfirm } = open({ kind: "attach", port: 9229 });

      fireEvent.click(start());

      expect(onConfirm).toHaveBeenCalledWith({ kind: "attach", port: 9229 });
    });

    it("blocks an attach on a port outside the range, with the range in the reason", () => {
      const { port } = open({ kind: "attach", port: 9229 });

      fireEvent.input(port(), { target: { value: "80" } });

      expect(
        screen.getByText("Enter a port between 1024 and 65535 (node's default is 9229)."),
      ).toBeTruthy();
      expect(start().disabled).toBe(true);
    });

    it("starts on Enter", () => {
      const { onConfirm, port } = open({ kind: "attach", port: 9229 });

      fireEvent.keyDown(port(), { key: "Enter" });

      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it("ignores Enter while the mode is blocked", () => {
      const { onConfirm, port } = open({ kind: "attach", port: 9229 });

      fireEvent.input(port(), { target: { value: "80" } });
      fireEvent.keyDown(port(), { key: "Enter" });

      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("cancels on Escape", () => {
      const { onCancel } = open();

      fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Escape" });

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("cancels on the Cancel button", () => {
      const { onCancel } = open();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("focuses the field the mode needs", async () => {
      const { port } = open({ kind: "attach", port: 9229 });
      await frame();

      expect(document.activeElement).toBe(port());
    });

    it("focuses nothing in a mode that has no field", async () => {
      open({ filePath: "/tmp/app.ts" });
      await frame();

      // Nothing to name: `first` is assigned by the select or the port input,
      // and this mode renders neither. After the migration this is the dialog
      // whose Enter has to be caught on the panel.
      expect(document.activeElement).toBe(document.body);
    });

    it("has no accessibility violations in attach mode", async () => {
      open({ kind: "attach", port: 9229 });

      await expectNoAxeViolations(document.body);
    });

    it("has no accessibility violations in script mode, bar the unnamed select", async () => {
      open({ kind: "script", scripts: ["dev", "test"] });

      // See the file header: `select-name` is the measured pre-existing
      // violation, fixed in phase 2 of #100. Every other rule still runs.
      await expectNoAxeViolations(document.body, {
        rules: { "select-name": { enabled: false } },
      });
    });
  });

  describe("shape", () => {
    // A `mousedown` on a real backdrop element; Kobalte dismisses on an outside
    // `pointerdown` from a `setTimeout(0)` listener instead.
    it("cancels on a mousedown on the backdrop", () => {
      const { onCancel } = open();

      fireEvent.mouseDown(document.querySelector(`.${styles.modalBackdrop}`)!);

      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("does not cancel on a mousedown inside the panel", () => {
      const { onCancel } = open();

      fireEvent.mouseDown(document.querySelector(`.${styles.modal}`)!);

      expect(onCancel).not.toHaveBeenCalled();
    });
  });
});
