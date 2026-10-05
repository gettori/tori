import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import { pointerClick } from "../../test/menus";
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
// **Accessibility, now clean in every mode.** The phase-1 baseline was: file and
// attach clean, script mode carrying one `select-name` violation, because the
// `<select>` was introduced by a `div.label` rather than a `<label>`. Both
// it and the port input are now named by `aria-labelledby` pointing at that same
// visible line, so the name and the text on screen cannot drift apart. The port
// input was not a violation (its `placeholder` stood in as the name) and was
// named anyway: a placeholder disappears the moment anything is typed. #106
// swapped the native `<select>` for `components/Select` and that naming carried
// over unchanged: the wrapper takes the same `aria-labelledby`, so the mode
// stayed clean across the migration rather than being re-fixed by it.
const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
// Kobalte installs its outside-pointerdown listener from a `setTimeout(0)`, so a
// press fired before this yield lands on nobody.
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

type Props = Parameters<typeof DebugTargetDialog>[0];

function open(props: Partial<Omit<Props, "onConfirm" | "onCancel">> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(() => (
    <DebugTargetDialog
      adapters={[{ id: "js-debug", label: "JavaScript / TypeScript (vscode-js-debug)" }]}
      kind="file"
      filePath={null}
      fileAdapter="js-debug"
      scripts={[]}
      port={9229}
      lldb={{ root: "/proj", bins: [], error: null }}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />
  ));
  // Asked through the accessibility tree, not through the class. Each mode
  // renders at most one of these, and they keep their roles after phase 2 names
  // the select, so these queries outlive both changes. The segments are toggle
  // buttons (Kobalte ToggleGroup), named uniquely, so `button` stays unambiguous.
  const mode = (name: string) => screen.getByRole("button", { name });
  const port = () => screen.getByRole("textbox") as HTMLInputElement;
  const script = () => screen.getByLabelText("Script") as HTMLButtonElement;
  return { onConfirm, onCancel, mode, port, script };
}

/** Pick a script by name. The control is a listbox behind a button since #106,
 *  so a choice is two presses rather than a `change` event, and the rows only
 *  exist while it is open. */
async function pickScript(trigger: HTMLElement, name: string) {
  pointerClick(trigger);
  await screen.findByRole("listbox");
  pointerClick(screen.getByRole("option", { name }));
  await macrotask();
}

const start = () => screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;

describe("DebugTargetDialog", () => {
  describe("contract", () => {
    it("opens on the mode the caller asked for", () => {
      const { mode } = open({ kind: "attach" });

      expect(mode("Attach").getAttribute("aria-pressed")).toBe("true");
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

      expect(onConfirm).toHaveBeenCalledWith({ adapterId: "js-debug", kind: "file", path: "/tmp/app.ts" });
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

      expect(onConfirm).toHaveBeenCalledWith({ adapterId: "js-debug", kind: "script", script: "dev" });
    });

    it("starts whichever script is picked", async () => {
      const { onConfirm, script } = open({ kind: "script", scripts: ["dev", "test"] });

      await pickScript(script(), "test");
      fireEvent.click(start());

      expect(onConfirm).toHaveBeenCalledWith({ adapterId: "js-debug", kind: "script", script: "test" });
    });

    it("offers the workspace's last port for an attach", () => {
      const { port } = open({ kind: "attach", port: 9230 });

      expect(port().value).toBe("9230");
    });

    it("starts an attach on a valid port, as a number", () => {
      const { onConfirm } = open({ kind: "attach", port: 9229 });

      fireEvent.click(start());

      expect(onConfirm).toHaveBeenCalledWith({ adapterId: "js-debug", kind: "attach", port: 9229 });
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

    it("has no accessibility violations in attach mode", async () => {
      open({ kind: "attach", port: 9229 });

      await expectNoAxeViolations(document.body);
    });

    it("has no accessibility violations in script mode", async () => {
      open({ kind: "script", scripts: ["dev", "test"] });

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

    // Moved here from `contract` during the migration, because it was
    // misfiled: where focus lands when a dialog names no target is a property
    // of the shell, not something a caller relies on. Before the swap it landed
    // on `<body>`, since nothing called `focus()` at all. Now the panel takes
    // it, which is what makes Enter reachable in this mode at all - the panel
    // is where the key is caught, and `<body>` was outside the dialog entirely.
    it("puts focus on the panel in a mode that has no field", async () => {
      open({ filePath: "/tmp/app.ts" });
      await frame();

      expect(document.activeElement).toBe(screen.getByRole("dialog"));
    });

    it("starts on Enter from the panel, where the focus actually is", async () => {
      const { onConfirm } = open({ filePath: "/tmp/app.ts" });
      await frame();

      fireEvent.keyDown(document.activeElement!, { key: "Enter" });

      expect(onConfirm).toHaveBeenCalledWith({ adapterId: "js-debug", kind: "file", path: "/tmp/app.ts" });
    });

    it("ignores Enter from the panel while the mode is blocked", async () => {
      const { onConfirm } = open();
      await frame();

      fireEvent.keyDown(document.activeElement!, { key: "Enter" });

      expect(onConfirm).not.toHaveBeenCalled();
    });
  });
});
