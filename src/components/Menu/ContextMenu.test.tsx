import { describe, it, expect, vi, beforeEach, onTestFinished } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import { pointerClick, rightClick } from "../../test/menus";
import Dialog from "../Dialog/Dialog";
import styles from "./Menu.module.css";
import ContextMenu from "./ContextMenu";
import type { MenuItem } from "./rows";

// Kobalte's dismissable layer installs its outside-pointerdown listener from a
// `setTimeout(0)`, the same seam `Dialog.test.tsx` documents. A test that
// dispatches the outside click without yielding is asserting on a listener that
// does not exist yet, and reads as "outside click does not close the menu".
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A focusable sibling outside the menu, removed even when the test fails.
 *  `cleanup` unmounts what `render` mounted and nothing else. */
function elementOutside() {
  const el = document.createElement("button");
  el.textContent = "Somewhere else";
  document.body.append(el);
  onTestFinished(() => el.remove());
  return el;
}

function mountRow(props: Parameters<typeof ContextMenu>[0] = {}) {
  const result = render(() => (
    <ContextMenu {...props}>{props.children ?? "a row"}</ContextMenu>
  ));
  return { ...result, row: screen.getByText("a row") };
}

// Cleared between tests, since two of them below assert `RENAME` was *not*
// called: shared and un-cleared, those would only pass for as long as no earlier
// test happened to pick that row.
const RENAME = vi.fn();
const DELETE = vi.fn();
beforeEach(() => {
  RENAME.mockClear();
  DELETE.mockClear();
});

const items = (): MenuItem[] => [
  { label: "Rename", onClick: RENAME },
  { separator: true },
  { label: "Delete", onClick: DELETE, danger: true },
];

describe("ContextMenu", () => {
  describe("what a right-click does", () => {
    it("claims the event and answers with a menu of the rows it was given", async () => {
      const { row } = mountRow({ items: items() });

      expect(rightClick(row)).toBe(true);

      const menu = await screen.findByRole("menu");
      expect(
        screen
          .getAllByRole("menuitem")
          .map((r) => r.textContent),
      ).toEqual(["Rename", "Delete"]);
      // The separator is the primitive's own `<hr>`, so it is announced as a
      // separator and skipped by arrow navigation without this file saying so.
      // Queried by role rather than by attribute: `<hr>` carries the role
      // implicitly and Kobalte writes no `role=` of its own.
      expect(menu.querySelectorAll("hr")).toHaveLength(1);
    });

    it("reports opening and closing, so an enclosing surface can track it", async () => {
      const onOpenChange = vi.fn();
      const { row } = mountRow({ items: items(), onOpenChange });

      rightClick(row);
      await screen.findByRole("menu");
      expect(onOpenChange).toHaveBeenCalledWith(true);

      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      await macrotask();
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
    });

    it("leaves the event alone when disabled, so the browser's own menu survives", () => {
      const { row } = mountRow({ items: items(), disabled: true });

      expect(rightClick(row)).toBe(false);
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  describe("how it closes", () => {
    it("closes on Escape without running anything", async () => {
      const { row } = mountRow({ items: items() });
      rightClick(row);
      const menu = await screen.findByRole("menu");

      fireEvent.keyDown(menu, { key: "Escape" });

      await screen.findByText("a row");
      expect(screen.queryByRole("menu")).toBeNull();
      expect(RENAME).not.toHaveBeenCalled();
    });

    it("closes on a pointer down outside it, without running anything", async () => {
      const outside = elementOutside();
      const { row } = mountRow({ items: items() });
      rightClick(row);
      await screen.findByRole("menu");
      await macrotask();

      fireEvent.pointerDown(outside);
      fireEvent.mouseDown(outside);

      await macrotask();
      expect(screen.queryByRole("menu")).toBeNull();
      expect(RENAME).not.toHaveBeenCalled();
    });

    it("closes when a row is picked, and runs that row's action", async () => {
      const rename = vi.fn();
      const { row } = mountRow({ items: [{ label: "Rename", onClick: rename }] });
      rightClick(row);
      await screen.findByRole("menu");

      pointerClick(screen.getByRole("menuitem", { name: "Rename" }));

      await macrotask();
      expect(rename).toHaveBeenCalledOnce();
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  describe("what the rows carry", () => {
    it("paints danger and warn, and leaves a disabled row to the primitive", async () => {
      const blocked = vi.fn();
      const { row } = mountRow({
        items: [
          { label: "Delete", onClick: () => {}, danger: true },
          { label: "Discard", onClick: () => {}, warn: true },
          { label: "Push", onClick: blocked, disabled: true },
        ],
      });
      rightClick(row);
      await screen.findByRole("menu");

      expect(screen.getByRole("menuitem", { name: "Delete" }).className).toContain(styles.danger);
      expect(screen.getByRole("menuitem", { name: "Discard" }).className).toContain(styles.warn);

      // `disabled` is the primitive's state rather than a class of ours, which
      // is what makes it block the action as well as paint it.
      const push = screen.getByRole("menuitem", { name: "Push" });
      expect(push.hasAttribute("data-disabled")).toBe(true);
      pointerClick(push);
      expect(blocked).not.toHaveBeenCalled();
    });
  });

  describe("what it deliberately does not do", () => {
    it("hides nothing and locks nothing, because it is not modal", async () => {
      const outside = elementOutside();
      const { row } = mountRow({ items: items() });

      rightClick(row);
      await screen.findByRole("menu");
      await macrotask();

      // Kobalte expresses modality by aria-hiding the rest of the document and
      // locking the page. Both would be wrong here: HistoryPanel's row menus
      // live inside the popover they belong to, and a modal one would aria-hide
      // its own panel.
      expect(outside.getAttribute("aria-hidden")).toBeNull();
      expect(document.body.style.overflow).not.toBe("hidden");
    });
  });

  describe("where it portals", () => {
    it("mounts into the enclosing dialog's panel rather than the body", async () => {
      render(() => (
        <Dialog open title="Rename branch" onClose={() => {}}>
          <ContextMenu items={items()}>a row</ContextMenu>
        </Dialog>
      ));

      rightClick(screen.getByText("a row"));
      const menu = await screen.findByRole("menu");

      // A dialog aria-hides everything outside its panel, so a body-portalled
      // menu would be painted on screen and absent from the accessibility tree
      // at the same time. See ../Dialog/surface.ts.
      expect(screen.getByRole("dialog").contains(menu)).toBe(true);
    });
  });

  describe("what the menu is acting on", () => {
    it("names the menu with a heading, which is not itself an option", async () => {
      const { row } = mountRow({ items: [{ heading: "web" }, ...items()] });
      rightClick(row);
      await screen.findByRole("menu");

      // Skipped by the arrows and by typeahead because it is not a row at all.
      expect(screen.getAllByRole("menuitem").map((r) => r.textContent)).toEqual([
        "Rename",
        "Delete",
      ]);
      // The name reaches a screen reader through the group it labels, rather
      // than being read out a second time where it sits.
      const group = screen.getByRole("group", { name: "web" });
      expect(group.textContent).toContain("web");
      expect(screen.getByText("web").getAttribute("aria-hidden")).toBe("true");
    });

    it("leaves a menu with no heading ungrouped", async () => {
      const { row } = mountRow({ items: items() });
      rightClick(row);
      await screen.findByRole("menu");

      // An unlabelled `role="group"` around every menu would be structure that
      // says nothing, so the group appears only with something to name it.
      expect(screen.queryByRole("group")).toBeNull();
    });
  });

  describe("the accessibility gate", () => {
    it("has no violations while open", async () => {
      const { row } = mountRow({ items: items() });
      rightClick(row);
      await screen.findByRole("menu");

      await expectNoAxeViolations(document.body);
    });

    it("has no violations with a heading either", async () => {
      const { row } = mountRow({ items: [{ heading: "web" }, ...items()] });
      rightClick(row);
      await screen.findByRole("menu");

      await expectNoAxeViolations(document.body);
    });
  });
});
