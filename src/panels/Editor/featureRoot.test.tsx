// The editor inside a Feature (#154 phase 1): tabs live under `feature:<id>`
// while git, settings and the watcher follow the active member, and a Feature
// with no present member opens empty rather than pointing anything at "".
// Then (#155 phase 2) the file tree draws one section per member, the unusable
// ones included, and a branch unit stays exactly as headerless as it was.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor } from "@solidjs/testing-library";

import { installResizeObserver, EMPTY_PANE } from "./__fixtures__/editorAgent";
import { installAnimationFrame } from "../../test/frames";

installResizeObserver();
installAnimationFrame();

const A = "/r/a/.sway/worktrees/auth";
const B = "/r/b/.sway/worktrees/auth";
const FILE = `${A}/a.txt`;
// The second member never got a worktree, so its section is keyed by the repo.
const REPO_B = "/r/b";

const FEATURE = {
  id: "f1",
  name: "Auth",
  branch: "feat/auth",
  createdAt: 1,
  members: [
    { repoPath: "/r/a", displayName: "api", worktreePath: A, state: { kind: "present" }, order: 0 },
    {
      repoPath: REPO_B,
      displayName: "web",
      worktreePath: null,
      state: { kind: "failed", reason: "clone refused" },
      order: 1,
    },
  ],
};

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args: args ?? {} });
    switch (cmd) {
      case "file_exists":
        return Promise.resolve(true);
      case "get_docs_root":
        return Promise.reject("no docs root");
      case "git_status":
      case "list_branches":
      case "fs_read_dir":
      case "fs_read_dir_compact":
      case "list_project_files":
        return Promise.resolve([]);
      case "list_features":
        return Promise.resolve([FEATURE]);
      case "get_config":
        return Promise.resolve({ spaces: [{ name: "work", color: "Sky", projects: [{ path: "/r/a" }] }] });
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: false });
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
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve(), retainLspRoots: () => Promise.resolve() }));

const { default: Editor } = await import("./Editor");
const { default: PaneView } = await import("../../tabs/PaneView");

const featureSel = (activeRoot: string | null, roots = [A, B]) => ({
  kind: "feature" as const,
  featureId: "f1",
  featureName: "Auth",
  roots,
  activeRoot,
  spaceName: "",
  projectName: "Auth",
  projectPath: activeRoot ?? "",
  folderPath: activeRoot ?? "",
  branch: "feat/auth",
  projectKind: "feature",
});

const unitSel = {
  kind: "unit",
  spaceName: "work",
  projectName: "a",
  projectPath: "/r/a",
  folderPath: "/r/a",
  branch: "main",
  projectKind: "plain",
};

// The right pane is portalled out of the render container, so the sections are
// found on the document rather than on what `render` hands back.
const sectionRoots = () =>
  Array.from(document.querySelectorAll("[data-root]")).map((e) => e.getAttribute("data-root"));

const rootsOf = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args.projectPath ?? c.args.root);
const store = () => JSON.parse(localStorage.getItem("sway.editor.tabs.v1") ?? "{}");

let mounted: ReturnType<typeof render> | null = null;
beforeEach(() => {
  localStorage.clear();
  calls.length = 0;
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("the editor inside a Feature", () => {
  it("keeps the strip under feature:<id> while git and the watcher follow the active member", async () => {
    localStorage.setItem(
      "sway.editor.tabs.v1",
      JSON.stringify({ "feature:f1": { paths: [FILE], active: FILE, savedAt: Date.now() } }),
    );
    const [sel, setSel] = createSignal(featureSel(A));
    mounted = render(() => (
      <>
        <Editor selected={sel() as never} />
        <PaneView pinKind="file" />
      </>
    ));
    await waitFor(() => expect(screen.queryByText(EMPTY_PANE)).toBeNull());
    await waitFor(() => expect(rootsOf("fs_watch_start")).toEqual([A]));

    setSel(featureSel(B));
    await waitFor(() => expect(rootsOf("fs_watch_start")).toEqual([A, B]));
    const gitRoots = rootsOf("git_status");
    expect(gitRoots[gitRoots.length - 1]).toBe(B);
    // The strip is the Feature's, so moving the root neither closes nor rehomes it.
    expect(screen.queryByText(EMPTY_PANE)).toBeNull();
    await waitFor(() => expect(store()["feature:f1"]?.paths).toEqual([FILE]));
    expect(store()).not.toHaveProperty(A);
    expect(store()).not.toHaveProperty(B);
  });

  it("opens a Feature with no present member as the empty state, pointing nothing at an empty root", async () => {
    mounted = render(() => (
      <>
        <Editor selected={featureSel(null, []) as never} />
        <PaneView pinKind="file" />
      </>
    ));
    await waitFor(() => expect(screen.queryByText(EMPTY_PANE)).toBeTruthy());
    expect(calls.filter((c) => c.cmd === "fs_watch_start")).toEqual([]);
    expect(calls.filter((c) => c.cmd === "git_status")).toEqual([]);
    expect(calls.filter((c) => c.cmd === "workspace_settings_load" || c.cmd === "load_workspace_settings")).toEqual([]);
  });
  it("draws one file-tree section per member and repairs the one with no worktree", async () => {
    mounted = render(() => (
      <>
        <Editor selected={featureSel(A, [A]) as never} />
        <PaneView pinKind="file" />
      </>
    ));
    await waitFor(() => expect(sectionRoots()).toEqual([A, REPO_B]));
    // Both members wear a chip, and the one outside every Space is untinted.
    const chips = Array.from(document.querySelectorAll<HTMLElement>("[data-chip]"));
    expect(chips.map((c) => c.textContent)).toEqual(["A", "W"]);
    expect(chips[0].style.getPropertyValue("--chip-hue")).not.toBe("");
    expect(chips[1].style.getPropertyValue("--chip-hue")).toBe("");

    const repair = document.querySelector<HTMLElement>(`[data-repair="${REPO_B}"]`)!;
    expect(repair.textContent).toBe("Retry");
    repair.click();
    await waitFor(() =>
      expect(calls.find((c) => c.cmd === "retry_member")?.args).toEqual({ featureId: "f1", repoPath: REPO_B }),
    );
  });

  it("leaves a branch unit headerless, with no member chip and no Feature record read", async () => {
    mounted = render(() => (
      <>
        <Editor selected={unitSel as never} />
        <PaneView pinKind="file" />
      </>
    ));
    await waitFor(() => expect(sectionRoots()).toEqual(["/r/a"]));
    expect(document.querySelectorAll("[data-chip]").length).toBe(0);
    expect(calls.some((c) => c.cmd === "list_features")).toBe(false);
  });
});
