import { describe, it, expect, vi } from "vite-plus/test";
import { createSignal } from "solid-js";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import ProjectStep from "./ProjectStep";

const space = { name: "work", path: "/w", projects: [] };

function mount() {
  const [layout, setLayout] = createSignal(true);
  render(() => (
    <ProjectStep
      space={space as never}
      home="/home"
      mode="clone"
      onMode={() => {}}
      worktreeLayout={layout()}
      onWorktreeLayout={setLayout}
      name="api"
      onName={() => {}}
      url=""
      onUrl={() => {}}
      git={null}
      onSubmit={vi.fn()}
      onInstallGit={() => {}}
      onCheckGit={() => {}}
    />
  ));
}

describe("first run's project step", () => {
  it("clones in the worktree layout by default, and plainly once the box is cleared", () => {
    mount();
    const box = screen.getByRole("checkbox", { name: "Worktree layout" }) as HTMLInputElement;

    expect(box.checked).toBe(true);
    expect(screen.getByText(/\/w\/api\/.bare plus a worktree for the default branch/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Bare/ })).toBeNull();

    fireEvent.click(box);

    expect(box.checked).toBe(false);
    expect(screen.getByText("Creates /w/api")).toBeTruthy();
  });
});
