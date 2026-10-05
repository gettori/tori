import { describe, it, expect, vi } from "vite-plus/test";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { Tabs } from "../../lib/tabs";
import { expectNoAxeViolations } from "../../test/axe";
import Tab from "./Tab";

// The tab pill on Kobalte, from the component's own side (gettori/tori#111,
// #115, #116).
//
// The strips have their own suites; what is pinned here is the part none of
// them can see, because they all mount a whole panel: that a close affordance
// beside a trigger inside a tablist is legal markup at all, and that closing
// from the keyboard does not need it to be a tab stop.

function mount(props: { onClose?: (e: MouseEvent | KeyboardEvent) => void } = {}) {
  return render(() => (
    <Tabs.Root defaultValue="a.ts">
      <Tabs.List aria-label="Open files">
        <Tab value="a.ts" onClose={props.onClose}>
          a.ts
        </Tab>
        <Tab value="b.ts" onClose={props.onClose}>
          b.ts
        </Tab>
      </Tabs.List>
    </Tabs.Root>
  ));
}

const closeOf = (name: string) => screen.getByRole("tab", { name }).parentElement!.querySelector("[data-tab-close]")!;

describe("the tab pill", () => {
  it("takes its selection and its tab stop from the strip above it", () => {
    mount();
    expect(screen.getByRole("tab", { name: "a.ts" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "b.ts" }).getAttribute("aria-selected")).toBe("false");
    // One stop for the whole strip: the unselected tab is reachable by arrow,
    // not by Tab, and the close button is never a stop at all.
    expect(screen.getByRole("tab", { name: "a.ts" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("tab", { name: "b.ts" }).getAttribute("tabindex")).toBe("-1");
  });

  it("never makes the close button a tab stop", () => {
    mount({ onClose: () => {} });
    for (const name of ["a.ts", "b.ts"]) {
      expect(closeOf(name).getAttribute("tabindex")).toBe("-1");
      expect(closeOf(name).getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("is clean with a close button beside the trigger", async () => {
    // The whole reason the close moved out of the trigger (#115) and lost its
    // label (#116). Both halves have to hold at once: `nested-interactive` is
    // what the old shape failed, and `aria-required-children` is what a
    // *labelled* sibling would fail instead, since a tablist may own nothing
    // but tabs.
    const { container } = mount({ onClose: () => {} });
    await expectNoAxeViolations(container);
  });

  it("closes on Delete and on Backspace, with the close button never focused", () => {
    const onClose = vi.fn();
    mount({ onClose });
    const b = screen.getByRole("tab", { name: "b.ts" });
    b.focus();

    fireEvent.keyDown(b, { key: "Delete" });
    fireEvent.keyDown(b, { key: "Backspace" });

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(b);
  });

  it("leaves other keys to the strip", () => {
    // Arrow keys are Kobalte's, and swallowing one here would take the strip's
    // navigation with it.
    const onClose = vi.fn();
    mount({ onClose });
    const b = screen.getByRole("tab", { name: "b.ts" });
    fireEvent.keyDown(b, { key: "ArrowLeft" });
    fireEvent.keyDown(b, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes from the pointer without selecting the tab it closed", () => {
    // The close is a sibling of the trigger rather than a child of it, so a
    // click on it is not a click on the tab. Kobalte selects on pointerdown,
    // which no `stopPropagation` in a click handler would have caught.
    const onClose = vi.fn();
    mount({ onClose });
    fireEvent.pointerDown(closeOf("b.ts"));
    fireEvent.click(closeOf("b.ts"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("tab", { name: "a.ts" }).getAttribute("aria-selected")).toBe("true");
  });

  it("is clean with an icon, a tooltip and trailing content", async () => {
    // The shape the strips actually render, and the one `Tab.stories.tsx`
    // shows. The scan above is the bare pill; this is the pill carrying every
    // slot it has, which is where a nameless glyph or a stray role would show
    // up. Trailing content with text of its own, as the Settings strip has,
    // because that is the case that changes the tab's accessible name.
    // Storybook has no axe gate of its own, so the stories lean on this.
    const { container } = render(() => (
      <Tabs.Root defaultValue="a.ts">
        <Tabs.List aria-label="Open files">
          <Tab
            value="a.ts"
            icon={
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 4h16v16H4z" />
              </svg>
            }
            tooltip="/src/a.ts"
            trailing={<span class="tab-badge">3</span>}
            onClose={() => {}}
          >
            a.ts
          </Tab>
        </Tabs.List>
      </Tabs.Root>
    ));
    await expectNoAxeViolations(container);
  });

  it("will not close a locked tab from the keyboard, the pointer or a middle click", () => {
    // The autopilot is driving it, so the one way to close it is to stop the
    // autopilot. The mark takes the close slot, so there is no button to click.
    const onClose = vi.fn();
    render(() => (
      <Tabs.Root defaultValue="a.ts">
        <Tabs.List aria-label="Open files">
          <Tab value="a.ts" onClose={onClose} locked={<span data-lock-mark="" />}>
            a.ts
          </Tab>
        </Tabs.List>
      </Tabs.Root>
    ));
    const a = screen.getByRole("tab", { name: "a.ts" });
    fireEvent.keyDown(a, { key: "Delete" });
    fireEvent.keyDown(a, { key: "Backspace" });
    fireEvent(a.parentElement!, new MouseEvent("auxclick", { bubbles: true, button: 1 }));

    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector("[data-tab-close]")).toBeNull();
    expect(document.querySelector("[data-lock-mark]")).not.toBeNull();
  });

  it("renders no close affordance when the strip does not close tabs", () => {
    mount();
    expect(document.querySelector("[data-tab-close]")).toBeNull();
  });
});
