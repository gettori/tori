// The topbar's two ways out of Tori, moved here from the end of the Toolbar's
// breadcrumb.
//
// What has to hold is that they open the *selected* folder and not the project
// container, that a focused chat turns the Ghostty button into a resume, and
// that a selection with no folder gets no buttons rather than two that refuse.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

const ROOT = "/w/web/.tori/worktrees/auth";

const bridge = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: Record<string, unknown> }[],
  fail: null as string | null,
  toasts: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args: args ?? {} });
    return bridge.fail ? Promise.reject(bridge.fail) : Promise.resolve(null);
  },
}));
vi.mock("../Toasts/Toasts", () => ({ pushToast: (m: string) => bridge.toasts.push(m) }));

const { default: HandOffs } = await import("./HandOffs");

const unitSel = {
  kind: "unit",
  spaceName: "work",
  projectName: "web",
  projectPath: "/w/web",
  folderPath: ROOT,
  branch: "feat/auth",
  projectKind: "plain",
};

const sessionSel = { ...unitSel, agent: "claude", sessionId: "s1", sessionPath: `${ROOT}/s1.jsonl`, sessionCwd: ROOT };

// A Topic whose members are all gone: a selection, and no folder behind it.
const rootlessSel = { kind: "feature", featureId: "f1", roots: [], activeRoot: null, spaceName: "", projectName: "Auth", projectPath: "", folderPath: "", branch: "" };

beforeEach(() => {
  bridge.calls = [];
  bridge.toasts = [];
  bridge.fail = null;
});

describe("the hand-off buttons", () => {
  it("opens VS Code at the selected folder, not at the project container", async () => {
    render(() => <HandOffs selected={unitSel as never} />);

    fireEvent.click(screen.getByRole("button", { name: "Open in VSCode" }));

    await waitFor(() =>
      expect(bridge.calls.find((c) => c.cmd === "open_in_vscode")?.args).toEqual({ path: ROOT }),
    );
  });

  it("opens a fresh Ghostty when nothing is focused", async () => {
    render(() => <HandOffs selected={unitSel as never} />);

    fireEvent.click(screen.getByRole("button", { name: "New in Ghostty" }));

    await waitFor(() =>
      expect(bridge.calls.find((c) => c.cmd === "open_in_ghostty")?.args).toEqual({
        cwd: ROOT,
        program: "claude",
        args: [],
      }),
    );
  });

  // The button reads the same selection the chat tab put there, so a focused
  // chat hands its own session over rather than starting a second one beside it.
  it("resumes the focused chat instead of starting a new one", async () => {
    render(() => <HandOffs selected={sessionSel as never} />);

    fireEvent.click(screen.getByRole("button", { name: "Resume in Ghostty" }));

    await waitFor(() =>
      expect(bridge.calls.find((c) => c.cmd === "open_in_ghostty")?.args).toEqual({
        cwd: ROOT,
        program: "claude",
        args: ["--resume", "s1"],
      }),
    );
  });

  it("offers nothing at all for a selection with no folder to hand over", () => {
    render(() => <HandOffs selected={rootlessSel as never} />);

    expect(screen.queryByRole("button", { name: /Ghostty/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /VSCode/ })).toBeNull();
  });

  it("offers nothing with no selection", () => {
    render(() => <HandOffs selected={null} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  // In the breadcrumb a failure had a second row under the crumb to land in. On
  // a 44px bar it has nowhere, so it leaves as a toast rather than as nothing.
  it("says so when a launch fails, rather than failing silently", async () => {
    bridge.fail = "ghostty: no such file or directory";
    render(() => <HandOffs selected={unitSel as never} />);

    fireEvent.click(screen.getByRole("button", { name: "New in Ghostty" }));

    await waitFor(() => expect(bridge.toasts).toEqual(["ghostty: no such file or directory"]));
  });
});
