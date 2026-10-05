import { describe, it, expect, vi, onTestFinished } from "vite-plus/test";
import { createSignal } from "solid-js";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import { pointerClick } from "../../test/menus";
import Dialog from "../Dialog/Dialog";
import Dropdown, { cursorRect } from "./Dropdown";
import { MenuRow, MenuSub, type MenuItem } from "./rows";

// Kobalte's focus scope focuses the content from a `setTimeout(0)`, and its
// dismissable layer installs the outside-pointerdown listener from another one.
// The same seam `Dialog.test.tsx` documents: assert without yielding and you are
// asserting on machinery that does not exist yet.
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

// Actions nothing here asserts on: every test that cares about one declares its
// own `vi.fn()` and reads it in the same block.
const items = (): MenuItem[] => [
  { label: "Alpha", onClick: () => {} },
  { label: "Beta", onClick: () => {} },
  { label: "Gamma", onClick: () => {} },
];

/** Which rows are highlighted, in order. `data-highlighted` is what Kobalte
 *  stamps on the row the arrows, Home/End or typeahead landed on, and what
 *  `Menu.module.css` paints. */
const highlighted = () =>
  screen
    .getAllByRole("menuitem")
    .filter((row) => row.hasAttribute("data-highlighted"))
    .map((row) => row.textContent);

function focusableOutside() {
  const el = document.createElement("input");
  document.body.append(el);
  onTestFinished(() => el.remove());
  return el;
}

describe("Dropdown", () => {
  describe("off a trigger", () => {
    it("opens on the trigger and lists the rows it was given", async () => {
      render(() => <Dropdown items={items()}>Open</Dropdown>);

      pointerClick(screen.getByText("Open"));

      await screen.findByRole("menu");
      expect(screen.getAllByRole("menuitem").map((r) => r.textContent)).toEqual([
        "Alpha",
        "Beta",
        "Gamma",
      ]);
    });

    it("hides nothing and locks nothing, because it is not modal", async () => {
      const outside = focusableOutside();
      render(() => <Dropdown items={items()}>Open</Dropdown>);

      pointerClick(screen.getByText("Open"));
      await screen.findByRole("menu");
      await macrotask();

      expect(outside.getAttribute("aria-hidden")).toBeNull();
      expect(document.body.style.overflow).not.toBe("hidden");
    });

    it("mounts into the enclosing dialog's panel rather than the body", async () => {
      render(() => (
        <Dialog open title="Pick a model" onClose={() => {}}>
          <Dropdown items={items()}>Open</Dropdown>
        </Dialog>
      ));

      pointerClick(screen.getByText("Open"));
      const menu = await screen.findByRole("menu");

      expect(screen.getByRole("dialog").contains(menu)).toBe(true);
    });
  });

  describe("at a point, with no trigger at all", () => {
    it("maps the anchor onto the rect the popper is given", () => {
      // The one thing about this mode that is ours rather than Kobalte's, and
      // the one thing jsdom cannot show: floating-ui has no geometry to work
      // with, so the positioner reads `top: 0; left: 0` whatever it is anchored
      // to. An x/y swap would render identically and pass every DOM assertion
      // in this file.
      expect(cursorRect({ x: 120, y: 340 })).toEqual({ x: 120, y: 340 });
      // The popper asks on its own schedule, so a menu closing by clearing its
      // anchor and its open state in one update can be asked once more on the
      // way out. The origin, not a throw.
      expect(cursorRect(undefined)).toEqual({ x: 0, y: 0 });
    });

    it("opens from state alone, and renders no trigger to open it with", async () => {
      render(() => (
        <Dropdown open anchor={{ x: 120, y: 340 }} items={items()} />
      ));

      const menu = await screen.findByRole("menu");
      expect(menu).toBeTruthy();
      expect(screen.queryByRole("button")).toBeNull();
    });

    it("gives focus to the menu, since there is no trigger holding it", async () => {
      render(() => (
        <Dropdown open anchor={{ x: 120, y: 340 }} items={items()} />
      ));
      await screen.findByRole("menu");
      await macrotask();

      expect(document.activeElement?.getAttribute("role")).toBe("menu");
    });

    it("hands focus back to wherever it came from when it closes", async () => {
      // Kobalte's close handler focuses its Trigger, and there is none here, so
      // its restore is a no-op and focus would land on `<body>`: for CodeEditor
      // that means the next keystroke goes nowhere instead of into the editor.
      const editor = focusableOutside();
      editor.focus();

      const [open, setOpen] = createSignal(true);
      render(() => (
        <Dropdown
          open={open()}
          anchor={{ x: 120, y: 340 }}
          items={items()}
          onOpenChange={setOpen}
        />
      ));
      await screen.findByRole("menu");
      await macrotask();
      expect(document.activeElement).not.toBe(editor);

      setOpen(false);
      await macrotask();

      expect(document.activeElement).toBe(editor);
    });
  });

  describe("the keyboard", () => {
    it("moves the highlight with the arrows, Home and End", async () => {
      render(() => <Dropdown open anchor={{ x: 0, y: 0 }} items={items()} />);
      const menu = await screen.findByRole("menu");
      await macrotask();

      fireEvent.keyDown(menu, { key: "ArrowDown" });
      expect(highlighted()).toEqual(["Alpha"]);

      fireEvent.keyDown(menu, { key: "ArrowDown" });
      expect(highlighted()).toEqual(["Beta"]);

      fireEvent.keyDown(menu, { key: "End" });
      expect(highlighted()).toEqual(["Gamma"]);

      fireEvent.keyDown(menu, { key: "Home" });
      expect(highlighted()).toEqual(["Alpha"]);
    });

    it("jumps to a row by typing its name", async () => {
      render(() => <Dropdown open anchor={{ x: 0, y: 0 }} items={items()} />);
      const menu = await screen.findByRole("menu");
      await macrotask();

      fireEvent.keyDown(menu, { key: "g" });

      expect(highlighted()).toEqual(["Gamma"]);
    });

    it("runs the highlighted row's action on Enter, and closes", async () => {
      const alpha = vi.fn();
      const [open, setOpen] = createSignal(true);
      render(() => (
        <Dropdown
          open={open()}
          anchor={{ x: 0, y: 0 }}
          items={[{ label: "Alpha", onClick: alpha }]}
          onOpenChange={setOpen}
        />
      ));
      const menu = await screen.findByRole("menu");
      await macrotask();

      fireEvent.keyDown(menu, { key: "ArrowDown" });
      const row = screen.getByRole("menuitem", { name: "Alpha" });
      fireEvent.keyDown(row, { key: "Enter" });

      await macrotask();
      expect(alpha).toHaveBeenCalledOnce();
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  describe("picking with the pointer", () => {
    it("runs the row's action and closes", async () => {
      const alpha = vi.fn();
      render(() => (
        <Dropdown items={[{ label: "Alpha", onClick: alpha }]}>Open</Dropdown>
      ));
      pointerClick(screen.getByText("Open"));
      await screen.findByRole("menu");

      pointerClick(screen.getByRole("menuitem", { name: "Alpha" }));

      await macrotask();
      expect(alpha).toHaveBeenCalledOnce();
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  describe("a level that opens beside a row", () => {
    // `mounted` counts renders of the submenu's contents, which is the whole
    // point of the level being lazy: Breadcrumbs puts a `createResource` here,
    // and a level that mounts with its parent would read every folder in the
    // list the moment the menu opened.
    function Level(props: { mounted: () => void }) {
      props.mounted();
      return <MenuRow onClick={() => {}}>main.tsx</MenuRow>;
    }

    function withSub(mounted: () => void) {
      return (
        <Dropdown
          menu={
            <>
              <MenuRow onClick={() => {}}>Alpha</MenuRow>
              <MenuSub label="src">
                <Level mounted={mounted} />
              </MenuSub>
            </>
          }
        >
          Open
        </Dropdown>
      );
    }

    it("mounts the level only once its row is opened", async () => {
      const mounted = vi.fn();
      render(() => withSub(mounted));

      pointerClick(screen.getByText("Open"));
      await screen.findByRole("menu");
      expect(mounted).not.toHaveBeenCalled();

      pointerClick(screen.getByRole("menuitem", { name: "src" }));

      expect(await screen.findByRole("menuitem", { name: "main.tsx" })).toBeTruthy();
      expect(mounted).toHaveBeenCalledOnce();
    });

    it("says it opens something, on the row rather than beside it", async () => {
      render(() => withSub(() => {}));
      pointerClick(screen.getByText("Open"));
      const row = await screen.findByRole("menuitem", { name: "src" });

      expect(row.getAttribute("aria-haspopup")).toBe("true");
      expect(row.getAttribute("aria-expanded")).toBe("false");

      pointerClick(row);

      await screen.findByRole("menuitem", { name: "main.tsx" });
      expect(row.getAttribute("aria-expanded")).toBe("true");
    });

    it("closes the whole stack when a row inside the level is picked", async () => {
      // Not only its own level: the parent menu is what the pick was made
      // *from*, and leaving it open would leave the choice looking unmade.
      const pick = vi.fn();
      render(() => (
        <Dropdown
          menu={
            <MenuSub label="src">
              <MenuRow onClick={pick}>main.tsx</MenuRow>
            </MenuSub>
          }
        >
          Open
        </Dropdown>
      ));
      pointerClick(screen.getByText("Open"));
      pointerClick(await screen.findByRole("menuitem", { name: "src" }));

      pointerClick(await screen.findByRole("menuitem", { name: "main.tsx" }));

      await macrotask();
      expect(pick).toHaveBeenCalledOnce();
      expect(screen.queryAllByRole("menu")).toEqual([]);
    });

    it("mounts the level where the menu it belongs to is mounted", async () => {
      // A flyout is its own portal, and asked where to go it would answer for
      // itself: in the body, while the rows it came from sat wherever the menu
      // was told to go. An explicit `mount` is what shows the difference, since
      // a dialog would answer the same for both.
      const elsewhere = document.createElement("div");
      document.body.append(elsewhere);
      onTestFinished(() => elsewhere.remove());

      render(() => (
        <Dropdown
          mount={elsewhere}
          menu={
            <MenuSub label="src">
              <MenuRow onClick={() => {}}>main.tsx</MenuRow>
            </MenuSub>
          }
        >
          Open
        </Dropdown>
      ));
      pointerClick(screen.getByText("Open"));
      pointerClick(await screen.findByRole("menuitem", { name: "src" }));

      const level = await screen.findByRole("menuitem", { name: "main.tsx" });
      expect(elsewhere.contains(level)).toBe(true);
    });

    it("has no violations with both levels on screen", async () => {
      render(() => withSub(() => {}));
      pointerClick(screen.getByText("Open"));
      pointerClick(await screen.findByRole("menuitem", { name: "src" }));
      await screen.findByRole("menuitem", { name: "main.tsx" });

      // Disabled for the reason the trigger scan below documents, and for one
      // more element here: a `SubTrigger` carries `aria-haspopup` and
      // `aria-controls` too, so it draws the same review item its menu's
      // trigger does.
      await expectNoAxeViolations(document.body, {
        rules: { "aria-valid-attr-value": { enabled: false } },
      });
    });
  });

  describe("the accessibility gate", () => {
    it("has no violations while open off a trigger", async () => {
      render(() => <Dropdown items={items()}>Open</Dropdown>);
      pointerClick(screen.getByText("Open"));
      await screen.findByRole("menu");

      // `aria-valid-attr-value` is turned off for this one scan, and not
      // because jsdom cannot judge it. axe raises a review item keyed
      // `controlsWithinPopup` for *any* trigger carrying both `aria-haspopup`
      // and `aria-controls`: it cannot tell whether the popup is currently
      // open, so it asks a human, in a real browser as much as here. Every
      // dropdown trigger Kobalte renders has both attributes. The rule still
      // runs in full over the anchor-mode scan below, which has no trigger, and
      // over `ContextMenu.test.tsx`, whose trigger carries neither.
      await expectNoAxeViolations(document.body, {
        rules: { "aria-valid-attr-value": { enabled: false } },
      });
    });

    it("has no violations while open at a point", async () => {
      render(() => (
        <Dropdown open anchor={{ x: 120, y: 340 }} items={items()} />
      ));
      await screen.findByRole("menu");

      await expectNoAxeViolations(document.body);
    });
  });
});
