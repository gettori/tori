// The pattern to copy for accessibility assertions on a component.
//
// `expectNoAxeViolations(container)` is the whole of it for an inline component.
// A portalled one (Dialogs, Popover, Omnibox, Toasts, ShortcutSheet) must be
// scoped to `document.body` instead, since a portal is a sibling of `container`
// rather than a descendant; see src/test/axe.ts and Toasts.test.tsx.
//
// Note the negative test below. An assertion that cannot fail is not a gate, and
// a labeled control passes axe trivially, so the fixture that breaks the
// component's documented contract is what proves this one has teeth.
import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import SegmentedControl from "./SegmentedControl";
import { expectNoAxeViolations, runAxe } from "../../test/axe";

const VIEWS = [
  { value: "list" as const, label: "List" },
  { value: "grid" as const, label: "Grid" },
];

const PANES = [
  { value: "files" as const, label: "Files" },
  { value: "changes" as const, label: "Changes" },
  { value: "search" as const, label: "Search" },
];

type Pane = (typeof PANES)[number]["value"];

/** The strip, controlled the way every consumer drives it. */
function mountPanes(initial: Pane = "files") {
  const [value, setValue] = createSignal<Pane>(initial);
  const onChange = vi.fn((v: Pane) => setValue(v));
  render(() => (
    <SegmentedControl
      options={PANES}
      value={value()}
      onChange={onChange}
      aria-label="Right panel"
    />
  ));
  const seg = (name: string) => screen.getByRole("button", { name });
  return { value, onChange, seg };
}

describe("SegmentedControl accessibility", () => {
  it("has no violations as a named group of named segments", async () => {
    const { container } = render(() => (
      <SegmentedControl
        options={VIEWS}
        value="list"
        onChange={() => {}}
        aria-label="View mode"
      />
    ));

    await expectNoAxeViolations(container);
  });

  // `SegmentedOption` documents `aria-label` as "required when there is no text
  // label", but both fields are optional to the type system, so nothing stops an
  // icon-only segment shipping nameless. This is the case the gate has to catch,
  // and asserting it is what keeps the test above from being decorative.
  it("catches an icon-only segment with no accessible name", async () => {
    const { container } = render(() => (
      <SegmentedControl
        options={[
          { value: "list", icon: <svg width="16" height="16" /> },
          { value: "grid", icon: <svg width="16" height="16" /> },
        ]}
        value="list"
        onChange={() => {}}
        aria-label="View mode"
      />
    ));

    const { violations } = await runAxe(container);
    // Reported as `button-name` rather than `aria-toggle-field-name`: a segment
    // is a plain `<button>` carrying `aria-pressed`, and axe names the defect
    // after the element.
    expect(violations.map((v) => v.id)).toContain("button-name");
  });
});

// The keyboard model changed with the move onto Kobalte's toggle group: it used
// to be a radiogroup where arrows moved the *selection*, and it is now the APG
// toggle-button pattern where arrows move only focus. These pin the new
// contract, since nothing else in the suite would notice it drifting back.
describe("SegmentedControl keyboard", () => {
  it("moves focus with arrows and Home/End without selecting", () => {
    const { value, onChange, seg } = mountPanes();

    seg("Files").focus();
    fireEvent.keyDown(seg("Files"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(seg("Changes"));
    expect(value()).toBe("files");

    fireEvent.keyDown(seg("Changes"), { key: "End" });
    expect(document.activeElement).toBe(seg("Search"));

    fireEvent.keyDown(seg("Search"), { key: "Home" });
    expect(document.activeElement).toBe(seg("Files"));

    fireEvent.keyDown(seg("Files"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(seg("Search"));

    // The whole tour, and the selection never moved.
    expect(onChange).not.toHaveBeenCalled();
    expect(value()).toBe("files");
  });

  it("selects the focused segment on Space and on Enter", () => {
    const { value, seg } = mountPanes();

    seg("Changes").focus();
    fireEvent.keyDown(seg("Changes"), { key: " " });
    fireEvent.keyUp(seg("Changes"), { key: " " });
    expect(value()).toBe("changes");

    seg("Search").focus();
    fireEvent.keyDown(seg("Search"), { key: "Enter" });
    expect(value()).toBe("search");
  });

  it("keeps one tab stop, and Tab enters on the selected segment", () => {
    // Kobalte parks the tab stop on the *group* until focus arrives, then hands
    // it to the selected segment and takes its own away. Either way the strip is
    // one stop, so Tab steps past it rather than through three segments.
    const { seg } = mountPanes("changes");
    const group = screen.getByRole("group", { name: "Right panel" });

    expect(group.getAttribute("tabindex")).toBe("0");
    for (const name of ["Files", "Changes", "Search"]) {
      expect(seg(name).getAttribute("tabindex")).toBe("-1");
    }

    group.focus();

    expect(document.activeElement).toBe(seg("Changes"));
    expect(group.getAttribute("tabindex")).toBe("-1");
    expect(seg("Changes").getAttribute("tabindex")).toBe("0");
    expect(seg("Files").getAttribute("tabindex")).toBe("-1");
    expect(seg("Search").getAttribute("tabindex")).toBe("-1");
  });

  it("holds the selection when the selected segment is pressed again", () => {
    // Kobalte's single mode allows clearing (`onChange(null)`); this API has no
    // empty state, so the press is a no-op rather than a deselect.
    const { value, onChange, seg } = mountPanes();

    fireEvent.click(seg("Files"));

    expect(value()).toBe("files");
    expect(onChange).not.toHaveBeenCalled();
  });

  // Both dialog consumers wrap the strip in a form-level Enter handler that
  // confirms the dialog. Kobalte activates on keydown and lets the event bubble,
  // so without containment one Enter would select a segment *and* submit.
  it("keeps its activation keys out of an enclosing Enter handler", () => {
    const onFormKeyDown = vi.fn();
    const [value, setValue] = createSignal<Pane>("files");
    render(() => (
      <div onKeyDown={onFormKeyDown}>
        <SegmentedControl
          options={PANES}
          value={value()}
          onChange={setValue}
          aria-label="Right panel"
        />
        <input aria-label="Name" />
      </div>
    ));

    const changes = screen.getByRole("button", { name: "Changes" });
    changes.focus();
    fireEvent.keyDown(changes, { key: "Enter" });

    expect(value()).toBe("changes");
    expect(onFormKeyDown).not.toHaveBeenCalled();

    // Outside the strip the dialog's own Enter is untouched.
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Enter" });
    expect(onFormKeyDown).toHaveBeenCalledTimes(1);
  });
});
