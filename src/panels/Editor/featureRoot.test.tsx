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
const { emitWith, FILE_RENAMED, PURGE_UNDER_PATH } = await import("../../utils/events");
const { isDirOpen, resetExpanded, setDirOpen } = await import("../../utils/treeExpanded");

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
const watchSets = () => calls.filter((c) => c.cmd === "fs_watch_set").map((c) => c.args.roots);
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
  it("keeps the strip under feature:<id> while git follows the active member and the watcher the whole set", async () => {
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
    // Every member at once, and not one `fs_watch_start` among them: a Feature
    // has no single foreground root for the LRU to name.
    await waitFor(() => expect(watchSets()).toEqual([[A, B]]));
    expect(rootsOf("fs_watch_start")).toEqual([]);

    setSel(featureSel(B));
    await waitFor(() => {
      const gitRoots = rootsOf("git_status");
      expect(gitRoots[gitRoots.length - 1]).toBe(B);
    });
    // The member list did not change, so the watcher was not re-issued.
    expect(watchSets()).toEqual([[A, B]]);
    // The strip is the Feature's, so moving the root neither closes nor rehomes it.
    expect(screen.queryByText(EMPTY_PANE)).toBeNull();
    await waitFor(() => expect(store()["feature:f1"]?.paths).toEqual([FILE]));
    expect(store()).not.toHaveProperty(A);
    expect(store()).not.toHaveProperty(B);
  });

  it("re-issues the watch set when a repaired member joins, and leaves a unit on the single-root watcher", async () => {
    const C = "/r/c/.sway/worktrees/auth";
    const [sel, setSel] = createSignal(featureSel(A));
    mounted = render(() => (
      <>
        <Editor selected={sel() as never} />
        <PaneView pinKind="file" />
      </>
    ));
    await waitFor(() => expect(watchSets()).toEqual([[A, B]]));

    setSel(featureSel(A, [A, B, C]));
    await waitFor(() => expect(watchSets()).toEqual([[A, B], [A, B, C]]));

    setSel(unitSel as never);
    await waitFor(() => expect(rootsOf("fs_watch_start")).toEqual(["/r/a"]));
    expect(watchSets()).toEqual([[A, B], [A, B, C]]);
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

// The tree's open directories are the sixth path-keyed store, and like the five
// before it the editor is what sweeps it: nothing else hears a rename, and a
// folder that has been trashed has no row left to collapse by hand.
describe("the tree's expanded set", () => {
  const WS = "/r/a";

  it("follows a renamed folder and drops a trashed one", async () => {
    resetExpanded();
    mounted = render(() => (
      <>
        <Editor selected={unitSel as never} />
        <PaneView pinKind="file" />
      </>
    ));
    await waitFor(() => expect(sectionRoots()).toEqual([WS]));
    setDirOpen(WS, `${WS}/src`, true);

    // Re-emitted until it lands: the editor subscribes from an async `onMount`,
    // and a rename that arrives before that is heard by nobody. Renaming a
    // folder that has already moved is a no-op, so the retry costs nothing.
    await waitFor(() => {
      emitWith(FILE_RENAMED, { from: `${WS}/src`, to: `${WS}/lib` });
      expect(isDirOpen(WS, `${WS}/lib`)).toBe(true);
    });
    expect(isDirOpen(WS, `${WS}/src`)).toBe(false);

    emitWith(PURGE_UNDER_PATH, { path: `${WS}/lib` });
    expect(isDirOpen(WS, `${WS}/lib`)).toBe(false);
  });
});
