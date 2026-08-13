import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";
import Dialog from "../Dialog/Dialog";
import IconButton from "../IconButton/IconButton";
import Tooltip from "./Tooltip";

// A glyph, so an icon-only control has no visible text and its accessible name
// can only come from a label.
const Glyph = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 5v14" />
  </svg>
);

/** Open the tooltip the way a keyboard user does. Kobalte opens on focus with
 *  no delay at all (`openTooltip(immediate)` is passed the focused flag), so
 *  unlike the hover path this needs no timers. */
function focusTrigger(trigger: HTMLElement) {
  trigger.focus();
  fireEvent.focus(trigger);
}

/** Let a modal dialog finish aria-hiding what is outside it.
 *
 *  Kobalte's `ariaHideOutside` watches the document with a `MutationObserver`
 *  and writes the attribute from inside `setTimeout(() =>
 *  requestAnimationFrame(...))`, so a node portalled onto the body is hidden two
 *  turns after it is inserted. Asserting synchronously would read the tree
 *  before that happens, and pass whether or not the tooltip was mounted in the
 *  right place - the shape of a test that cannot fail. */
function settleAriaHidden(): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(() => requestAnimationFrame(() => resolve())),
  );
}

describe("Tooltip", () => {
  it("opens on keyboard focus, not only on hover", () => {
    render(() => (
      <Tooltip label="Run the file" as="button">
        Run
      </Tooltip>
    ));

    const trigger = screen.getByRole("button", { name: "Run" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    focusTrigger(trigger);

    // The whole reason this ticket exists: a native `title` never appears for a
    // keyboard user, and this does. Hand-written rather than left to axe, which
    // under jsdom cannot judge whether anything is reachable without a pointer.
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });

  it("describes the trigger, and puts the wiring on the trigger itself", () => {
    render(() => (
      <Tooltip label="Run the file" as="button">
        Run
      </Tooltip>
    ));

    const trigger = screen.getByRole("button", { name: "Run" });
    focusTrigger(trigger);

    // `aria-describedby` on the *control*, resolving to the tooltip's own node.
    // A trigger on a wrapping element would leave the button undescribed while
    // still looking correct on screen, which is the failure this asserts away.
    const tooltip = screen.getByRole("tooltip");
    expect(trigger.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(tooltip.textContent).toBe("Run the file");

    // A description, never a name: the button is still named by its own text.
    expect(trigger.textContent).toBe("Run");
  });

  it("closes on Escape", () => {
    render(() => (
      <Tooltip label="Run the file" as="button">
        Run
      </Tooltip>
    ));

    const trigger = screen.getByRole("button", { name: "Run" });
    focusTrigger(trigger);
    expect(screen.getByRole("tooltip")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(trigger.getAttribute("aria-describedby")).toBeNull();
  });

  it("keeps the trigger's own handlers, rather than replacing them", () => {
    let clicked = 0;
    render(() => (
      <Tooltip label="Run the file" as="button" onClick={() => clicked++}>
        Run
      </Tooltip>
    ));

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(clicked).toBe(1);
  });

  it("has no accessibility violations while open", async () => {
    render(() => (
      <Tooltip label="Run the file" as="button">
        Run
      </Tooltip>
    ));
    focusTrigger(screen.getByRole("button", { name: "Run" }));

    // `document.body`, not the render container: the content is portalled, so a
    // container-scoped run would audit a div the tooltip is not in.
    await expectNoAxeViolations(document.body);
  });

  describe("inside a dialog", () => {
    it("portals into the panel, not into the aria-hidden document", async () => {
      render(() => (
        <Dialog open title="Commit" onClose={() => {}}>
          <Tooltip label="Amend the previous commit" as="button">
            Amend
          </Tooltip>
        </Dialog>
      ));

      focusTrigger(screen.getByRole("button", { name: "Amend" }));
      const tooltip = screen.getByRole("tooltip");
      await settleAriaHidden();

      // The panel is the only subtree `createHideOutside` leaves alone, so
      // "inside the panel" and "not inside an aria-hidden subtree" are the same
      // claim made two ways. Both are asserted: the first is what the `mount`
      // seam does, the second is why it has to. Both fail with the seam removed
      // - which is the only reason the second one is worth writing.
      const panel = screen.getByRole("dialog");
      expect(panel.contains(tooltip)).toBe(true);
      expect(tooltip.closest("[aria-hidden='true']")).toBeNull();
    });

    it("is still the trigger's description once portalled into the panel", () => {
      render(() => (
        <Dialog open title="Commit" onClose={() => {}}>
          <Tooltip label="Amend the previous commit" as="button">
            Amend
          </Tooltip>
        </Dialog>
      ));

      const trigger = screen.getByRole("button", { name: "Amend" });
      focusTrigger(trigger);

      expect(trigger.getAttribute("aria-describedby")).toBe(
        screen.getByRole("tooltip").id,
      );
    });
  });

  // The three controls compose this rather than owning a tooltip each, because
  // 101 of the ticket's 134 sites have no `aria-label` and route their name
  // through the control. These assert the composition, not the primitive.
  describe("composed into IconButton", () => {
    it("still exposes an accessible name with no aria-label", () => {
      render(() => <IconButton icon={<Glyph />} tooltip="Split the editor" />);

      // The backfill: the tooltip text *is* the name, exactly as the `title` it
      // replaces was. Losing this at 101 call sites is the regression the whole
      // ticket is arranged to avoid.
      expect(
        screen.getByRole("button", { name: "Split the editor" }),
      ).toBeTruthy();
    });

    it("emits no native title, so the two cannot disagree", () => {
      render(() => <IconButton icon={<Glyph />} tooltip="Split the editor" />);

      expect(screen.getByRole("button").getAttribute("title")).toBeNull();
    });

    it("puts aria-describedby on the button itself when focused", () => {
      render(() => <IconButton icon={<Glyph />} tooltip="Split the editor" />);

      const button = screen.getByRole("button", { name: "Split the editor" });
      focusTrigger(button);

      // On the button, not on a wrapper: Kobalte's trigger carries the wiring,
      // and `focus` neither bubbles nor is delegated by Solid, so a trigger
      // anywhere else would leave this attribute on an element no assistive
      // technology is looking at.
      const tooltip = screen.getByRole("tooltip");
      expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);
      expect(button.tagName).toBe("BUTTON");
    });

    it("opens on Tab-to-focus, which a native title never did", () => {
      render(() => (
        <>
          <button>before</button>
          <IconButton icon={<Glyph />} tooltip="Split the editor" />
        </>
      ));

      // Tabbing is the browser's job and jsdom does not move focus for a
      // keypress, so the arrival is what is simulated - the assertion is that
      // arriving by focus (rather than by pointer) is what opens it.
      const button = screen.getByRole("button", { name: "Split the editor" });
      focusTrigger(button);

      expect(screen.getByRole("tooltip").textContent).toBe("Split the editor");
      expect(document.activeElement).toBe(button);
    });

    it("adds no tooltip machinery when no tooltip is given", () => {
      const { container } = render(() => (
        <IconButton icon={<Glyph />} aria-label="Split the editor" />
      ));

      // The untooltipped path is most of the app, and it stays a bare button.
      const button = screen.getByRole("button", { name: "Split the editor" });
      expect(button.parentElement).toBe(container);
      expect(button.getAttribute("aria-describedby")).toBeNull();
    });
  });

  describe("whenDisabled", () => {
    it("renders no hover surface by default", () => {
      const { container } = render(() => (
        <Tooltip label="Run the file" as="button">
          Run
        </Tooltip>
      ));

      // Default off is the load-bearing half: 134 call sites adopt `tooltip`
      // without any of them changing DOM shape unless they ask to.
      expect(container.querySelector("[data-tooltip-hover-surface]")).toBeNull();
    });

    it("wraps the control in a hover surface when asked", () => {
      const { container } = render(() => (
        <Tooltip label="Nothing staged to commit" as="button" whenDisabled disabled>
          Commit
        </Tooltip>
      ));

      const surface = container.querySelector("[data-tooltip-hover-surface]");
      expect(surface).toBeTruthy();
      expect(surface!.contains(screen.getByRole("button"))).toBe(true);
    });

    it("opens from the surface while the control is disabled", async () => {
      render(() => (
        <Tooltip
          label="Nothing staged to commit"
          as="button"
          whenDisabled
          disabled
          openDelay={0}
        >
          Commit
        </Tooltip>
      ));

      const surface = document.querySelector("[data-tooltip-hover-surface]")!;
      fireEvent.pointerEnter(surface);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(screen.getByRole("tooltip")).toBeTruthy();
    });
  });
});
