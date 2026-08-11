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
import { describe, expect, it } from "vitest";
import { render } from "@solidjs/testing-library";
import SegmentedControl from "./SegmentedControl";
import { expectNoAxeViolations, runAxe } from "../../test/axe";

const VIEWS = [
  { value: "list" as const, label: "List" },
  { value: "grid" as const, label: "Grid" },
];

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
    // is a `<button role="radio">`, and axe names the defect after the element.
    expect(violations.map((v) => v.id)).toContain("button-name");
  });
});
