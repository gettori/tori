// The Problems tab inside a Feature (#160 phase 1). The store spans every warm
// project, so what decides whether the tab exists is the scope the editor gives
// it: one branch unit's folder, or every member of a Feature at once.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";

import { installResizeObserver } from "./__fixtures__/editorAgent";
import { installAnimationFrame } from "../../test/frames";

installResizeObserver();
installAnimationFrame();

const A = "/r/a/.sway/worktrees/auth";
const B = "/r/b/.sway/worktrees/auth";

const FEATURE = {
  id: "f1",
  name: "Auth",
  branch: "feat/auth",
  createdAt: 1,
  members: [
    { repoPath: "/r/a", displayName: "api", worktreePath: A, state: { kind: "present" }, order: 0 },
    { repoPath: "/r/b", displayName: "web", worktreePath: B, state: { kind: "present" }, order: 1 },
  ],
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    switch (cmd) {
      case "list_features":
        return Promise.resolve([FEATURE]);
      case "get_config":
        return Promise.resolve({ spaces: [] });
      case "git_status":
      case "list_branches":
      case "fs_read_dir":
      case "fs_read_dir_compact":
      case "list_project_files":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: () => Promise.resolve(() => {}) }),
}));
vi.mock("./CodeEditor", () => ({ default: () => null }));
vi.mock("./lspClient", () => ({
  stopAllLsp: () => Promise.resolve(),
  stopEvictedLspRoots: () => Promise.resolve(),
}));

const { default: Editor } = await import("./Editor");
const { clearDiagnostics, publishDiagnostics } = await import("../../utils/diagnostics");

const featureSel = (activeRoot: string) => ({
  kind: "feature" as const,
  featureId: "f1",
  featureName: "Auth",
  roots: [A, B],
  activeRoot,
  spaceName: "",
  projectName: "Auth",
  projectPath: activeRoot,
  folderPath: activeRoot,
  branch: "feat/auth",
  projectKind: "feature",
});

const problem = (line: number, message: string) => [
  { line, endLine: line, column: 1, severity: "error" as const, message },
];

const problemsTab = () => screen.queryByRole("tab", { name: "Problems" });

let mounted: ReturnType<typeof render> | null = null;
beforeEach(() => {
  localStorage.clear();
  clearDiagnostics();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  clearDiagnostics();
});

describe("the Problems tab inside a Feature", () => {
  it("is offered for a diagnostic in the member you are not looking at", async () => {
    // `activeRoot` is the api member; the error is in web. Scoping the tab to
    // the active member alone would hide the only problems the Feature has.
    publishDiagnostics(`${B}/src/b.ts`, problem(9, "web broke"));
    mounted = render(() => <Editor selected={featureSel(A) as never} />);
    await waitFor(() => expect(problemsTab()).toBeTruthy());
  });

  it("lists that member's problems once the tab is opened", async () => {
    publishDiagnostics(`${B}/src/b.ts`, problem(9, "web broke"));
    mounted = render(() => <Editor selected={featureSel(A) as never} />);
    await waitFor(() => expect(problemsTab()).toBeTruthy());
    fireEvent.click(problemsTab()!);
    await waitFor(() => expect(screen.getByText("web broke")).toBeTruthy());
    // Under the member it belongs to, not under the active one.
    const web = document.querySelector(`[data-root="${B}"]`);
    expect(web?.textContent).toContain("web broke");
  });

  it("does not offer it for a diagnostic in no member of this Feature", async () => {
    publishDiagnostics("/elsewhere/c.ts", problem(1, "someone else's"));
    mounted = render(() => <Editor selected={featureSel(A) as never} />);
    // Nothing to wait for, so the absence is asserted after the tabs settle.
    await waitFor(() => expect(screen.getByRole("tab", { name: "Files" })).toBeTruthy());
    expect(problemsTab()).toBeNull();
  });

  it("falls the pane back to Files when the last member's diagnostics clear", async () => {
    publishDiagnostics(`${B}/src/b.ts`, problem(9, "web broke"));
    mounted = render(() => <Editor selected={featureSel(A) as never} />);
    await waitFor(() => expect(problemsTab()).toBeTruthy());
    fireEvent.click(problemsTab()!);
    await waitFor(() => expect(screen.getByText("web broke")).toBeTruthy());

    clearDiagnostics();
    await waitFor(() => expect(problemsTab()).toBeNull());
    // Not stuck on a mode the selection can no longer show.
    expect(screen.queryByText("web broke")).toBeNull();
  });

  it("keeps the tab while moving the active member between them", async () => {
    publishDiagnostics(`${B}/src/b.ts`, problem(9, "web broke"));
    const [sel, setSel] = createSignal(featureSel(A));
    mounted = render(() => <Editor selected={sel() as never} />);
    await waitFor(() => expect(problemsTab()).toBeTruthy());
    setSel(featureSel(B));
    expect(problemsTab()).toBeTruthy();
  });
});
