import { describe, it, expect } from "vite-plus/test";
import { render, screen } from "@solidjs/testing-library";
import { Dialog } from "./dialog";

// The smoke test for the whole `lib/` seam, not for Kobalte's dialog.
//
// Kobalte is inlined by `vitest.config.ts` because its `solid` export is
// untransformed JSX and its `default` export reaches for its own copy of
// `solid-js/web`. Neither failure is visible from the config file; both are
// visible the moment a Kobalte part is actually mounted. So one composition is
// mounted here, through the namespace the app is meant to use, and it stays
// after #98 builds the styled wrapper on top: the wrapper's own tests would
// fail for reasons of their own, and this one only ever fails for the seam.
describe("the Kobalte dialog, through src/lib", () => {
  it("mounts every re-exported part into one portalled dialog", () => {
    render(() => (
      <Dialog.Root open>
        <Dialog.Portal>
          <Dialog.Overlay data-testid="overlay" />
          <Dialog.Content>
            <Dialog.Title>Title</Dialog.Title>
            <Dialog.Description>Description</Dialog.Description>
            <Dialog.CloseButton>Close</Dialog.CloseButton>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    ));

    // Portalled, so it hangs off document.body rather than the render
    // container - which is exactly the case a second Solid instance would
    // strand, since `cleanup` disposes only roots in its own reactive graph.
    const dialog = screen.getByRole("dialog");
    expect(document.body.contains(dialog)).toBe(true);
    expect(screen.getByTestId("overlay")).toBeTruthy();

    // The behaviour Tori adopted Kobalte *for*: the title and description are
    // wired to the dialog by id, not merely rendered next to it, and the
    // content is fenced by focus-trap sentinels - the ShortcutSheet pattern,
    // generalized.
    expect(dialog.getAttribute("aria-labelledby")).toBe(screen.getByText("Title").id);
    expect(dialog.getAttribute("aria-describedby")).toBe(screen.getByText("Description").id);
    expect(dialog.querySelectorAll("[data-focus-trap]")).toHaveLength(2);

    // `CloseButton` labels itself "Dismiss" whatever its children say, so its
    // accessible name is *not* the text a reader sees. A styled wrapper that
    // wants the two to agree has to pass `aria-label` through.
    expect(screen.getByRole("button", { name: "Dismiss" }).textContent).toBe("Close");
  });

  it("keeps a closed dialog out of the tree entirely", () => {
    render(() => (
      <Dialog.Root open={false}>
        <Dialog.Portal>
          <Dialog.Content>
            <Dialog.Title>Hidden</Dialog.Title>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    ));

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
