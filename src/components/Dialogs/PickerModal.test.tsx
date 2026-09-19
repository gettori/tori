import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import PickerModal from "./PickerModal";

// Characterization test for the fuzzy single-select picker behind `askPick`,
// written against the hand-rolled implementation and kept green across two
// migrations: onto `components/Dialog` (#100), and onto the shared
// `components/Combobox` (#110). Contract / shape split as in
// `ConfirmDialog.test.tsx`.
//
// This is the one dialog in the set whose *body* also changed rather than
// moved: the rows are now a real `listbox` of `option`s with the keyboard
// selection announced through `aria-activedescendant`. That splits the
// assertions here differently from the other six, and the split is deliberate:
//
//   * **contract** - which item a keystroke commits. `ArrowDown` then `Enter`
//     selects the second match whether the highlight is expressed by a class or
//     by `aria-activedescendant`, so these survived the change.
//   * **shape** - *how* the highlight is expressed. Against the hand-rolled
//     markup that could only be asked by reading `styles.active` off a `div`,
//     because the rows carried no roles at all; that gap is what this migration
//     closed, so these now ask the accessibility tree the same questions and
//     name no CSS Module class.
//
// Enter is contract for the reason given in `WorktreeRemoveDialog.test.tsx`:
// the handler is explicit either side of the swap, and every assertion fires
// the key on the input, which is where it is handled now and after.
//
// The empty result set is worth its own attention rather than a footnote: a
// `listbox` whose only child is the "No matches" line owns no options, and an
// `aria-activedescendant` left pointing at a row that is no longer rendered
// names nothing. Both are asserted below, the first through axe.
//
// **Accessibility, and a baseline that flattered itself.** Phase 1 recorded
// zero violations here, which was true of the picker this file renders and not
// of the one the app renders: `askPick` passes no placeholder, and a
// placeholder was the only thing naming the filter field. Every assertion in
// this file supplied one, because it needs a handle to type into, so the gate
// could never see the gap. The field carries a real `aria-label` now, and one
// axe assertion below deliberately renders the picker the way the callers do.
const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
// Kobalte installs its outside-pointerdown listener from a `setTimeout(0)`, so a
// press fired before this yield lands on nobody.
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

type Props = Parameters<typeof PickerModal>[0];

function open(props: Partial<Omit<Props, "onSubmit" | "onCancel">> = {}) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(() => (
    <PickerModal
      title="Attach a branch"
      items={["main", "develop", "feature/omnibox"]}
      placeholder="Filter branches"
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...props}
    />
  ));
  const input = () => screen.getByPlaceholderText("Filter branches") as HTMLInputElement;
  const rows = () => screen.queryAllByRole("option");
  // The selection as a screen reader would resolve it: follow the input's
  // `aria-activedescendant` to the row it names.
  const active = () => {
    const id = input().getAttribute("aria-activedescendant");
    return id ? rows().find((r) => r.id === id) : undefined;
  };
  return { onSubmit, onCancel, input, rows, active };
}

const type = (el: HTMLInputElement, value: string) =>
  fireEvent.input(el, { target: { value } });

describe("PickerModal", () => {
  describe("contract", () => {
    it("names what is being picked", () => {
      open();

      expect(screen.getByText("Attach a branch")).toBeTruthy();
    });

    it("offers every item before anything is typed", () => {
      const { rows } = open();

      expect(rows().map((r) => r.textContent)).toEqual([
        "main",
        "develop",
        "feature/omnibox",
      ]);
    });

    it("narrows the list as the filter is typed", () => {
      const { input, rows } = open();

      type(input(), "omni");

      expect(rows().map((r) => r.textContent)).toEqual(["feature/omnibox"]);
    });

    it("says so when nothing matches", () => {
      const { input, rows } = open();

      type(input(), "zzzz");

      expect(rows()).toHaveLength(0);
      expect(screen.getByText("No matches")).toBeTruthy();
    });

    it("commits the highlighted item on Enter", () => {
      const { onSubmit, input } = open();

      fireEvent.keyDown(input(), { key: "Enter" });

      expect(onSubmit).toHaveBeenCalledWith("main");
    });

    it("moves the highlight down and commits what it lands on", () => {
      const { onSubmit, input } = open();

      fireEvent.keyDown(input(), { key: "ArrowDown" });
      fireEvent.keyDown(input(), { key: "Enter" });

      expect(onSubmit).toHaveBeenCalledWith("develop");
    });

    it("wraps from the last item back to the first", () => {
      const { onSubmit, input } = open();

      fireEvent.keyDown(input(), { key: "ArrowUp" });
      fireEvent.keyDown(input(), { key: "Enter" });

      expect(onSubmit).toHaveBeenCalledWith("feature/omnibox");
    });

    it("commits the filtered highlight, not the item that was first before typing", () => {
      const { onSubmit, input } = open();

      type(input(), "e");
      fireEvent.keyDown(input(), { key: "Enter" });

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit.mock.calls[0][0]).not.toBe("main");
    });

    it("commits the row that is clicked", () => {
      const { onSubmit, rows } = open();

      fireEvent.click(rows()[1]);

      expect(onSubmit).toHaveBeenCalledWith("develop");
    });

    // A real mouse presses, releases and only then clicks, and the list under
    // it can move in between: the attach flow folds fetched remote branches
    // into the open dialog, which grows a centred panel and slides every row.
    it("commits the row pressed, not the row released over", () => {
      const { onSubmit, rows } = open();
      const pressed = rows()[0];
      const released = rows()[1];

      fireEvent.pointerMove(pressed, { pointerType: "mouse" });
      fireEvent.pointerDown(pressed, { pointerType: "mouse", button: 0 });
      fireEvent.pointerUp(released, { pointerType: "mouse", button: 0 });
      // What the browser does when press and release land on different rows:
      // the click goes to their common ancestor, which is no row at all.
      fireEvent.click(screen.getByRole("listbox"));

      expect(onSubmit).not.toHaveBeenCalledWith("develop");
    });

    it("still commits a press and release on one row", () => {
      const { onSubmit, rows } = open();
      const row = rows()[1];

      fireEvent.pointerMove(row, { pointerType: "mouse" });
      fireEvent.pointerDown(row, { pointerType: "mouse", button: 0 });
      fireEvent.pointerUp(row, { pointerType: "mouse", button: 0 });
      fireEvent.click(row);

      expect(onSubmit).toHaveBeenCalledWith("develop");
    });

    it("commits an exactly typed item on Ok", () => {
      const { onSubmit, input } = open();

      type(input(), "develop");
      fireEvent.click(screen.getByRole("button", { name: "OK" }));

      expect(onSubmit).toHaveBeenCalledWith("develop");
    });

    it("refuses to invent an item when it is not creatable", () => {
      const { onSubmit, input } = open();

      type(input(), "brand-new");
      fireEvent.click(screen.getByRole("button", { name: "OK" }));

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("creates the typed name on Ok when it is creatable", () => {
      const { onSubmit, input } = open({ creatable: true, okLabel: "Create" });

      type(input(), "brand-new");
      fireEvent.click(screen.getByRole("button", { name: "Create" }));

      expect(onSubmit).toHaveBeenCalledWith("brand-new");
    });

    it("still accepts the highlight on Enter while rows match, creatable or not", () => {
      const { onSubmit, input } = open({ creatable: true });

      type(input(), "main");
      fireEvent.keyDown(input(), { key: "Enter" });

      expect(onSubmit).toHaveBeenCalledWith("main");
    });

    it("clears the filter and hands focus back to it", () => {
      const { input, rows } = open();

      type(input(), "omni");
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));

      expect(input().value).toBe("");
      expect(rows()).toHaveLength(3);
      expect(document.activeElement).toBe(input());
    });

    it("offers no clear button until there is something to clear", () => {
      const { input } = open();

      expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();

      type(input(), "o");

      expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
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

    it("focuses the filter", async () => {
      const { input } = open();
      await frame();

      expect(document.activeElement).toBe(input());
    });

    // `aria-valid-attr-value` off while the list is up, the precedent
    // `Select.test.tsx` and `Dropdown.test.tsx` set: axe's `controlsWithinPopup`
    // declines to judge `aria-controls` on anything carrying `aria-haspopup`,
    // because it cannot tell whether the popup is open, in a real browser as
    // much as here. Kobalte's combobox input carries both (#110). The withdrawn
    // case below still runs the rule in full, and what it would have checked is
    // asserted directly in "announces the list as a listbox the filter drives".
    it("has no accessibility violations", async () => {
      open();

      await expectNoAxeViolations(document.body, {
        rules: { "aria-valid-attr-value": { enabled: false } },
      });
    });

    // The state the listbox has to be *withdrawn* for. `aria-required-children`
    // is the rule that would fire if the "No matches" line were left sitting
    // inside a `role="listbox"`, and it is the reason this assertion exists
    // separately from the one above rather than being folded into it.
    it("has no accessibility violations with nothing left to pick", async () => {
      const { input } = open();

      type(input(), "zzzz");

      await expectNoAxeViolations(document.body);
    });

    // The configuration the app actually renders, and the one every other
    // assertion in this file misses: `askPick` takes a title, items and
    // `creatable`, and passes no placeholder at all. The two above supply one
    // because they need a handle to type into, and a placeholder is enough for
    // axe to call the field named - so a picker that was green in this file
    // could still reach a user with no accessible name on its only input, which
    // is exactly what it did before the `aria-label` fallback.
    it("has no accessibility violations as the callers actually render it", async () => {
      render(() => (
        <PickerModal
          title="Attach a branch"
          items={["main", "develop"]}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />
      ));

      await expectNoAxeViolations(document.body, {
        rules: { "aria-valid-attr-value": { enabled: false } },
      });
    });
  });

  describe("shape", () => {
    // How the highlight is expressed, asked through the accessibility tree now
    // that there is one: the input names the active row, and the row says it is
    // selected. Against the hand-rolled markup the same questions could only be
    // asked by reading a CSS Module class off an unroled `div`.
    it("announces the list as a listbox the filter drives", () => {
      const { input, rows } = open();

      const list = screen.getByRole("listbox");
      expect(input().getAttribute("aria-controls")).toBe(list.id);
      expect(rows()).toHaveLength(3);
    });

    // Re-characterized on the move to the shared surface (#110). The active row
    // is `aria-activedescendant` plus `data-highlighted`, and `aria-selected` is
    // *not* it: in a combobox that attribute means the committed value, and this
    // picker commits and closes, so no row is ever selected while it is on
    // screen. The old markup conflated the two because it had only one way to
    // say "this row".
    it("marks exactly the active row as highlighted, and selects none of them", () => {
      const { input, rows, active } = open();

      fireEvent.keyDown(input(), { key: "ArrowDown" });

      expect(rows().filter((r) => r.hasAttribute("data-highlighted"))).toEqual([active()]);
      expect(rows().every((r) => r.getAttribute("aria-selected") === "false")).toBe(true);
    });

    it("withdraws the listbox when there is nothing to own, and points nowhere", () => {
      const { input } = open();

      type(input(), "zzzz");

      expect(screen.queryByRole("listbox")).toBeNull();
      expect(input().getAttribute("aria-activedescendant")).toBeNull();
    });

    it("highlights the first row to start with", () => {
      const { active } = open();

      expect(active()?.textContent).toBe("main");
    });

    it("moves the highlight with the arrow keys", () => {
      const { input, active } = open();

      fireEvent.keyDown(input(), { key: "ArrowDown" });

      expect(active()?.textContent).toBe("develop");
    });

    // Deliberately *not* the mouse. The highlight is what Enter and Ok commit,
    // and hover-focus made both follow the pointer: pointing at a row while
    // pressing Ok took that row, and the same consent let a release over a
    // moved list commit a row nobody pressed. Hover keeps its own background.
    it("stays where the keyboard put it while the mouse moves over the list", () => {
      const { rows, active } = open();

      fireEvent.pointerMove(rows()[2], { pointerType: "mouse" });

      expect(active()?.textContent).toBe("main");
    });

    // Named class rather than a measured height, which jsdom has none of. The
    // rule it stands for: a list still being filled is the size it will end up,
    // so what lands late cannot slide the rows out from under the cursor.
    //
    // Asked of the list's scroll frame rather than the list: the bound belongs
    // to whatever scrolls, and the list is the content of an overlay scroller
    // now rather than a scroller itself.
    const reserved = () => screen.getByRole("listbox").closest("[class*='pickerListReserved']");

    it("holds the list at its full height when more rows are coming", () => {
      open({ reserve: true });
      expect(reserved()).toBeTruthy();
    });

    it("lets a settled list size itself", () => {
      open();
      expect(reserved()).toBeNull();
    });

    it("pulls the highlight back into range when the filter shortens the list", () => {
      const { input, active } = open();

      fireEvent.keyDown(input(), { key: "ArrowUp" });
      type(input(), "omni");

      expect(active()?.textContent).toBe("feature/omnibox");
    });

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
