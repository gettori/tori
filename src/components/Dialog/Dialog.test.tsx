import { describe, it, expect, vi, onTestFinished } from "vitest";
import { createSignal, type JSX } from "solid-js";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import styles from "./Dialog.module.css";
import Dialog, { type DialogProps } from "./Dialog";

// Kobalte's focus scope dispatches its unmount auto-focus event, and installs
// its outside-pointerdown listener, from a `setTimeout(0)`. A test that asserts
// on either without yielding is asserting on a listener that does not exist yet
// or a restore that has not run, and reads as "Kobalte does not do this".
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

// A button outside the dialog, removed even when the test fails. `cleanup`
// unmounts what `render` mounted and nothing else, so a leaked focusable in
// `document.body` would be aria-hidden by the *next* test's modal and fail its
// axe run instead of this one.
function buttonOutsideTheDialog() {
  const button = document.createElement("button");
  button.textContent = "Opener";
  document.body.append(button);
  onTestFinished(() => button.remove());
  return button;
}

function openDialog(
  props: Partial<Omit<DialogProps, "open" | "onClose">> = {},
  children?: JSX.Element,
) {
  const [open, setOpen] = createSignal(true);
  const onClose = vi.fn(() => setOpen(false));
  render(() => (
    <Dialog open={open()} title="Delete branch" onClose={onClose} {...props}>
      {children}
    </Dialog>
  ));
  return { onClose, setOpen };
}

describe("Dialog", () => {
  describe("the accessible shell", () => {
    it("is a modal dialog named by its own title", () => {
      openDialog({ description: "This cannot be undone." });

      const dialog = screen.getByRole("dialog");
      // `aria-modal` is the wrapper's own doing: Kobalte expresses modality by
      // aria-hiding everything else and never sets the attribute.
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(dialog.getAttribute("aria-labelledby")).toBe(
        screen.getByText("Delete branch").id,
      );
      expect(dialog.getAttribute("aria-describedby")).toBe(
        screen.getByText("This cannot be undone.").id,
      );
    });

    it("keeps a hidden title as the accessible name", () => {
      openDialog({ titleHidden: true });

      const title = screen.getByText("Delete branch");
      expect(title.className).toBe(styles.titleHidden);
      expect(screen.getByRole("dialog").getAttribute("aria-labelledby")).toBe(
        title.id,
      );
    });

    it("carries a caller's class beside its own", () => {
      openDialog({ class: "pickerBody", size: "wide" });

      const dialog = screen.getByRole("dialog");
      expect(dialog.classList.contains("pickerBody")).toBe(true);
      expect(dialog.classList.contains(styles.panel)).toBe(true);
      expect(dialog.classList.contains(styles.wide)).toBe(true);
    });
  });

  describe("sizes", () => {
    // The width itself cannot be asserted here: vitest stubs the stylesheet, so
    // jsdom resolves no `var()` and every panel measures zero. What is assertable
    // is that each size reaches its own rule, which is what silently breaks when
    // a key is renamed in one file and not the other.
    it.each(["confirm", "sheet", "wide"] as const)(
      "puts %s on its own rule",
      (size) => {
        openDialog({ size });

        const dialog = screen.getByRole("dialog");
        expect(dialog.classList.contains(styles[size])).toBe(true);
        expect(styles[size]).toBeTruthy();
      },
    );

    it("defaults to confirm", () => {
      openDialog();

      expect(
        screen.getByRole("dialog").classList.contains(styles.confirm),
      ).toBe(true);
    });
  });

  describe("the scrolling body", () => {
    // The one guard axe cannot be: `scrollable-region-focusable` is disabled
    // under jsdom, which has no scroll geometry, so a body that scrolls but
    // cannot be focused would pass every accessibility assertion in the suite
    // while being unscrollable by keyboard.
    it("is reachable by keyboard, since it is the scroll region", () => {
      openDialog({}, "A body with no control of its own.");

      const body = screen.getByText("A body with no control of its own.");
      expect(body.className).toBe(styles.body);
      expect(body.tabIndex).toBe(0);
    });

    it("is absent when the dialog has no body, rather than an empty tab stop", () => {
      openDialog({ description: "Nothing else to say." });

      expect(
        screen.getByRole("dialog").querySelector(`.${styles.body}`),
      ).toBeNull();
    });
  });

  describe("dismissal", () => {
    it("closes on Escape", () => {
      const { onClose } = openDialog();

      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      });

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes on a pointer down outside the panel", async () => {
      const { onClose } = openDialog();
      await macrotask();

      fireEvent.pointerDown(document.body);

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("focus", () => {
    it("focuses the panel when no initial focus is named", () => {
      openDialog();

      expect(document.activeElement).toBe(screen.getByRole("dialog"));
    });

    it("focuses the element the caller names", () => {
      let input: HTMLInputElement | undefined;
      openDialog(
        { initialFocus: () => input },
        <input ref={input} aria-label="Branch name" />,
      );

      expect(document.activeElement).toBe(input);
    });

    it("restores focus to whatever it interrupted", async () => {
      const opener = buttonOutsideTheDialog();
      opener.focus();
      expect(document.activeElement).toBe(opener);

      const { setOpen } = openDialog();
      expect(document.activeElement).not.toBe(opener);

      setOpen(false);
      await macrotask();

      // Kobalte's own modal restore focuses a `Trigger` this app never renders,
      // so without the wrapper's capture-and-restore this lands on <body>.
      expect(document.activeElement).toBe(opener);
    });

    it("wraps focus back into the panel at the trap sentinels", () => {
      openDialog(
        {},
        <>
          <button>First</button>
          <button>Last</button>
        </>,
      );

      const sentinels = screen
        .getByRole("dialog")
        .querySelectorAll<HTMLElement>("[data-focus-trap]");
      expect(sentinels).toHaveLength(2);

      // Tabbing past the last control lands on the end sentinel, which throws
      // focus back to the first tabbable. That is the body, not the first
      // button: the body carries `tabindex=0` because it is the scroll region.
      // Real Tab traversal is not simulated: jsdom implements no sequential
      // focus navigation and this repo has no user-event, so a keydown-based
      // assertion would pass without moving anything.
      sentinels[1].focus();
      expect(document.activeElement).toBe(
        screen.getByRole("dialog").querySelector(`.${styles.body}`),
      );
    });

    it("pulls focus back when something outside steals it", () => {
      const outside = buttonOutsideTheDialog();
      openDialog({}, <button>Inside</button>);
      const inside = screen.getByRole("button", { name: "Inside" });
      inside.focus();

      outside.focus();

      expect(document.activeElement).toBe(inside);
    });
  });

  describe("accessibility", () => {
    // Scoped to `document.body`, because the dialog is portalled and is
    // therefore a sibling of render's container rather than inside it. The three
    // cases vary the *content*, not the size: axe sees no CSS here, so three
    // sizes of the same markup would be one assertion written three times.
    it("has no violations as a prose confirmation", async () => {
      openDialog({ description: "This cannot be undone." }, "Delete `main`?");

      await expectNoAxeViolations(document.body);
    });

    it("has no violations as a form with an actions row", async () => {
      openDialog(
        {
          size: "sheet",
          description: "Names may not contain spaces.",
          actions: (
            <>
              <button>Cancel</button>
              <button>Create</button>
            </>
          ),
        },
        <label>
          Branch name
          <input />
        </label>,
      );

      await expectNoAxeViolations(document.body);
    });

    it("has no violations with a hidden title and a long body", async () => {
      openDialog(
        { size: "wide", titleHidden: true },
        <ul>
          {Array.from({ length: 40 }, (_, i) => (
            <li>Row {i}</li>
          ))}
        </ul>,
      );

      await expectNoAxeViolations(document.body);
    });
  });
});
