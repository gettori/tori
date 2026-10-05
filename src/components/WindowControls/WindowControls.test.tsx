// The titlebar's left cluster after phase 13: the sidebar toggle where the
// traffic lights end, and the editor's jump navigation at the far end of the
// rail. The navigation is not rendered here - the editor portals it into a
// module-owned host - so what this pins is that the slot adopts that host, and
// that the pane toggles it used to hold are gone.
import { describe, it, expect } from "vite-plus/test";
import { render, screen } from "@solidjs/testing-library";
import WindowControls from "./WindowControls";
import { stageHost } from "../../tabs/stageHost";

describe("WindowControls", () => {
  it("holds the sidebar toggle and nothing that hides a pane", () => {
    render(() => <WindowControls showSidebar />);
    expect(screen.getByRole("button", { name: /Show or hide the sidebar/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show or hide the terminal/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Show or hide the editor/ })).toBeNull();
  });

  it("adopts the editor's navigation host at the rail's far end", () => {
    const { container } = render(() => <WindowControls showSidebar />);
    const host = stageHost("editor-nav");
    expect(container.contains(host)).toBe(true);
    // Last in the cluster, which is what puts it at the right edge.
    expect(host.parentElement).toBe(container.firstElementChild!.lastElementChild);
  });
});
