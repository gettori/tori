// The pattern to copy for a *portalled* component.
//
// `Toasts` renders inside a `<Portal>`, which mounts to `document.body`. That
// makes it a sibling of the `container` returned by `render`, not a descendant,
// so the scope rule is:
//
//   * inline component  -> `expectNoAxeViolations(container)`
//   * portalled component -> `expectNoAxeViolations(document.body)`
//
// Getting this wrong does not fail loudly: a container-scoped run on a portalled
// component audits an empty div and passes. `src/test/domSetup.ts` unmounts after
// each test, so a body-scoped run only ever sees the current test's DOM.
import { describe, expect, it } from "vitest";
import { render } from "@solidjs/testing-library";
import Toasts, { type Toast } from "./Toasts";
import { expectNoAxeViolations } from "../../test/axe";

const TOASTS: Toast[] = [
  { id: 1, message: "Could not remove the worktree", kind: "error" },
  { id: 2, message: "Renamed 12 files", kind: "info", action: { label: "Undo", run: () => {} } },
];

describe("Toasts accessibility", () => {
  it("has no violations in the portalled stack", async () => {
    render(() => <Toasts toasts={TOASTS} onDismiss={() => {}} />);

    // `document.body`, not `container`: the stack is portalled.
    await expectNoAxeViolations(document.body);
  });

  // Guards the scope rule itself. If this ever starts finding the toasts, the
  // portal has stopped being a portal and the comment above is wrong.
  it("is not reachable from the render container, which is why the scope differs", () => {
    const { container } = render(() => (
      <Toasts toasts={TOASTS} onDismiss={() => {}} />
    ));

    expect(container.textContent).toBe("");
    expect(document.body.textContent).toContain("Could not remove the worktree");
  });
});
