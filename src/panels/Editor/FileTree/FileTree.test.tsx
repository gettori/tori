import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent, within } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../../test/axe";
import { pointerClick } from "../../../test/menus";

// The file tree's editable mode, driven through the real component.
//
// Containment itself is the backend's job and is proven in `fs.rs`; what is
// asserted here is strictly the tree's own half: which command each action
// sends, that every one carries the root it was mounted with (so the project
// tree can never be handed the `.shared` fence by accident), and that the
// directory an action touched is re-read afterwards so the change shows.

type Entry = { name: string; path: string; is_dir: boolean; ignored: boolean };
type Call = { cmd: string; args: Record<string, unknown> };

const file = (dir: string, name: string): Entry => ({
  name,
  path: `${dir}/${name}`,
  is_dir: false,
  ignored: false,
});
const folder = (dir: string, name: string): Entry => ({
  name,
  path: `${dir}/${name}`,
  is_dir: true,
  ignored: false,
});

const bridge: {
  calls: Call[];
  dirs: Record<string, Entry[]>;
  existing: Set<string>;
  failRename: boolean;
  projectFiles: string[];
  /** Per-root file lists, for the multi-root filter. Falls back to the flat
   *  `projectFiles` so every single-root test reads exactly as it did. */
  filesByRoot: Record<string, string[]>;
  overlay: Record<string, unknown>;
} = {
  calls: [],
  dirs: {},
  existing: new Set(),
  failRename: false,
  projectFiles: [],
  filesByRoot: {},
  overlay: {},
};

const sent = (cmd: string) => bridge.calls.filter((c) => c.cmd === cmd);
const readsOf = (path: string) =>
  sent("fs_read_dir_compact").filter((c) => c.args.path === path);

const listeners = vi.hoisted(() => ({}) as Record<string, ((e: { payload: unknown }) => void)[]>);
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    (listeners[name] ??= []).push(cb);
    return Promise.resolve(() => {
      const arr = listeners[name] ?? [];
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    });
  },
}));

/** One watcher burst, as the backend tags it. */
const fsChanged = (root: string, paths: string[]) =>
  (listeners["fs://changed"] ?? []).slice().forEach((cb) => cb({ payload: { root, paths } }));

vi.mock("@tauri-apps/api/core", async () => {
  const { compactRows } = await import("../../../test/compactDirs");
  return {
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args });
    if (cmd === "fs_read_dir_compact")
      return Promise.resolve(
        compactRows(bridge.dirs, args as { path: string; compact: boolean; hidden: string[] }),
      );
    if (cmd === "fs_read_dir") return Promise.resolve(bridge.dirs[args.path as string] ?? []);
    if (cmd === "list_project_files")
      return Promise.resolve(bridge.filesByRoot[args.projectPath as string] ?? bridge.projectFiles);
    if (cmd === "file_exists") return Promise.resolve(bridge.existing.has(args.path as string));
    if (cmd === "fs_rename" && bridge.failRename)
      return Promise.reject("A file or folder with that name already exists.");
    // The per-workspace overlay. Empty unless a test says otherwise, so every
    // other case here runs on the user layer exactly as it always did.
    if (cmd === "get_workspace_settings") return Promise.resolve({ editor: bridge.overlay });
    return Promise.resolve(null);
  },
  };
});

import FileTree, { clearListingCache, type TreeRoot } from "./FileTree";
import { memberState } from "../../../utils/features";
import styles from "./FileTree.module.css";
import { loadWorkspaceSettings } from "../../Settings/settingsStore";

const ROOT = "/proj";

// Prompts resolve immediately: what is under test is the command the answer
// produces, not the dialog that collected it.
const answering = (name: string | null) => vi.fn().mockResolvedValue(name);
const confirming = (ok: boolean) => vi.fn().mockResolvedValue(ok);

function mountProject(overrides: Record<string, unknown> = {}) {
  return render(() => (
    <FileTree
      root={ROOT}
      editable
      noun="project folder"
      askText={answering("ignored")}
      askConfirm={confirming(true)}
      {...overrides}
    />
  ));
}

// A stand-in for the browser's DataTransfer. `types` is derived rather than
// stored because the drop-target check reads it during dragover, when the values
// themselves are deliberately unreadable.
function dataTransfer() {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    effectAllowed: "",
    dropEffect: "",
  };
}

/** The row element, which is where the drag handlers live; `getByText` lands on
 *  the name span inside it. */
const rowFor = (name: string) => screen.getByText(name).parentElement!;

beforeEach(async () => {
  clearListingCache();
  bridge.calls = [];
  bridge.existing = new Set();
  bridge.failRename = false;
  bridge.projectFiles = [];
  bridge.filesByRoot = {};
  bridge.overlay = {};
  // The overlay lives in a module-level store that outlives any one mount, so a
  // test that selected a workspace would otherwise hand its answers to every
  // test after it.
  await loadWorkspaceSettings(null);
  bridge.dirs = {
    [ROOT]: [folder(ROOT, "src"), folder(ROOT, "docs"), file(ROOT, "README.md")],
    [`${ROOT}/src`]: [folder(`${ROOT}/src`, "utils"), file(`${ROOT}/src`, "main.ts")],
    [`${ROOT}/src/utils`]: [],
  };
});

describe("the editable project tree", () => {
  it("creates a file under the workspace root and re-reads the directory", async () => {
    const askText = answering("notes.md");
    mountProject({ askText });
    await screen.findByText("README.md");
    const before = readsOf(ROOT).length;

    fireEvent.click(screen.getByLabelText("New File"));

    await waitFor(() => expect(sent("fs_write_file")).toHaveLength(1));
    expect(askText).toHaveBeenCalled();

    // The write lands inside the root the tree was mounted with...
    expect(sent("fs_write_file")[0].args).toMatchObject({ path: `${ROOT}/notes.md`, contents: "" });
    // ...and the containment call names that same root, not `.shared`.
    expect(sent("fs_mkdir")[0].args).toMatchObject({ root: ROOT, noun: "project folder" });
    // The directory is re-read, so the new file is visible without a remount.
    await waitFor(() => expect(readsOf(ROOT).length).toBeGreaterThan(before));
  });

  it("never clobbers an existing file when creating one", async () => {
    bridge.existing.add(`${ROOT}/README.md`);
    mountProject({ askText: answering("README.md") });
    await screen.findByText("README.md");

    fireEvent.click(screen.getByLabelText("New File"));

    await waitFor(() => expect(sent("file_exists")).toHaveLength(1));
    // The whole point: an existing name opens the file rather than truncating it.
    expect(sent("fs_write_file")).toHaveLength(0);
  });

  it("renames through the fenced command, keeping the file in its own directory", async () => {
    mountProject({ askText: answering("guide.md") });
    await screen.findByText("README.md");

    fireEvent.contextMenu(screen.getByText("README.md"));
    pointerClick(await screen.findByText("Rename"));

    await waitFor(() => expect(sent("fs_rename")).toHaveLength(1));
    expect(sent("fs_rename")[0].args).toEqual({
      root: ROOT,
      from: `${ROOT}/README.md`,
      to: `${ROOT}/guide.md`,
      noun: "project folder",
    });
  });

  it("carries the file's saved versions to the new path", async () => {
    // Local history is keyed by path, so without this a rename orphans every
    // version under a name nothing will ever ask about again. After the move,
    // because a folder rename is read off the destination.
    mountProject({ askText: answering("guide.md") });
    await screen.findByText("README.md");

    fireEvent.contextMenu(screen.getByText("README.md"));
    pointerClick(await screen.findByText("Rename"));

    await waitFor(() => expect(sent("local_history_rename")).toHaveLength(1));
    expect(sent("local_history_rename")[0].args).toEqual({
      repoPath: ROOT,
      from: `${ROOT}/README.md`,
      to: `${ROOT}/guide.md`,
    });
    expect(bridge.calls.findIndex((c) => c.cmd === "fs_rename")).toBeLessThan(
      bridge.calls.findIndex((c) => c.cmd === "local_history_rename"),
    );
  });

  it("drops the file's saved versions before it goes to the Trash", async () => {
    // Before, not after: a folder's versions can only be found by walking it,
    // and by the time it is in the Trash there is nothing left to walk.
    mountProject({ askConfirm: confirming(true) });
    await screen.findByText("README.md");

    fireEvent.contextMenu(screen.getByText("README.md"));
    pointerClick(await screen.findByText("Delete"));

    await waitFor(() => expect(sent("fs_delete")).toHaveLength(1));
    expect(sent("local_history_forget")[0].args).toEqual({
      repoPath: ROOT,
      path: `${ROOT}/README.md`,
    });
    expect(bridge.calls.findIndex((c) => c.cmd === "local_history_forget")).toBeLessThan(
      bridge.calls.findIndex((c) => c.cmd === "fs_delete"),
    );
  });

  it("deletes only after a confirmation, and fences the delete to the root", async () => {
    const askConfirm = confirming(true);
    mountProject({ askConfirm });
    await screen.findByText("README.md");

    fireEvent.contextMenu(screen.getByText("README.md"));
    pointerClick(await screen.findByText("Delete"));

    await waitFor(() => expect(sent("fs_delete")).toHaveLength(1));
    expect(sent("fs_delete")[0].args).toEqual({
      root: ROOT,
      path: `${ROOT}/README.md`,
      noun: "project folder",
    });
    // The dialog must not promise more damage than the backend does: the file
    // goes to the Trash, so "cannot be undone" would be a lie.
    const opts = askConfirm.mock.calls[0][0] as { message?: string };
    expect(opts.message).toMatch(/Trash/i);
  });

  it("does not delete when the confirmation is declined", async () => {
    mountProject({ askConfirm: confirming(false) });
    await screen.findByText("README.md");

    fireEvent.contextMenu(screen.getByText("README.md"));
    pointerClick(await screen.findByText("Delete"));

    await waitFor(() => expect(screen.queryByText("Delete")).toBeNull());
    expect(sent("fs_delete")).toHaveLength(0);
  });

  it("offers no mutating affordances when it is not editable", async () => {
    render(() => <FileTree root={ROOT} />);
    await screen.findByText("README.md");

    expect(screen.queryByLabelText("New File")).toBeNull();
    fireEvent.contextMenu(screen.getByText("README.md"));

    await waitFor(() => expect(screen.queryByText("Rename")).toBeNull());
    expect(sent("fs_rename")).toHaveLength(0);
  });
});

describe("filtering, collapsing and compaction", () => {
  it("filters over the whole project, not just the rows that happen to be open", async () => {
    // `src/utils` is collapsed, so a filter that only looked at visible rows
    // would miss everything inside it, which is most of a real project.
    bridge.projectFiles = ["README.md", "src/main.ts", "src/utils/helpers.ts"];
    mountProject();
    await screen.findByText("README.md");

    fireEvent.input(screen.getByLabelText("Filter files"), { target: { value: "helpers" } });

    await screen.findByText("src/utils/helpers.ts");
    expect(screen.queryByText("README.md")).toBeNull();
  });

  it("ranks the best match first and says so when nothing matches", async () => {
    bridge.projectFiles = ["src/deep/nested/main.ts", "main.ts"];
    mountProject();
    await screen.findByText("README.md");
    const box = screen.getByLabelText("Filter files");

    fireEvent.input(box, { target: { value: "main" } });
    await screen.findByText("main.ts");
    const rows = screen.getAllByText(/main\.ts$/);
    expect(rows[0].textContent).toBe("main.ts");

    fireEvent.input(box, { target: { value: "zzzznope" } });
    await screen.findByText("No files match that filter.");
  });

  it("restores the tree when the filter is cleared", async () => {
    bridge.projectFiles = ["README.md"];
    mountProject();
    await screen.findByText("README.md");

    const box = screen.getByLabelText("Filter files");
    fireEvent.input(box, { target: { value: "read" } });
    await waitFor(() => expect(screen.queryByText("src")).toBeNull());

    fireEvent.input(box, { target: { value: "" } });
    await screen.findByText("src");
  });

  it("closes every expanded folder at once", async () => {
    mountProject();
    fireEvent.click(await screen.findByText("src"));
    await screen.findByText("main.ts");

    fireEvent.click(screen.getByLabelText("Collapse all folders"));

    await waitFor(() => expect(screen.queryByText("main.ts")).toBeNull());
    // The folder itself stays: collapse-all closes, it does not hide.
    expect(screen.getByText("src")).toBeTruthy();
  });

  it("draws a single-child folder chain as one row", async () => {
    // `pkg` holds only `inner`, which holds only `deep`, which holds the file.
    bridge.dirs = {
      [ROOT]: [folder(ROOT, "pkg")],
      [`${ROOT}/pkg`]: [folder(`${ROOT}/pkg`, "inner")],
      [`${ROOT}/pkg/inner`]: [folder(`${ROOT}/pkg/inner`, "deep")],
      [`${ROOT}/pkg/inner/deep`]: [file(`${ROOT}/pkg/inner/deep`, "thing.ts")],
    };
    mountProject();

    await screen.findByText("pkg/inner/deep");
    // One row, and it acts on the deepest folder: expanding shows the file.
    fireEvent.click(screen.getByText("pkg/inner/deep"));
    await screen.findByText("thing.ts");
  });

  it("stops compacting where a folder has more than one child", async () => {
    bridge.dirs = {
      [ROOT]: [folder(ROOT, "pkg")],
      [`${ROOT}/pkg`]: [folder(`${ROOT}/pkg`, "inner")],
      [`${ROOT}/pkg/inner`]: [file(`${ROOT}/pkg/inner`, "a.ts"), file(`${ROOT}/pkg/inner`, "b.ts")],
    };
    mountProject();

    await screen.findByText("pkg/inner");
    fireEvent.click(screen.getByText("pkg/inner"));
    await screen.findByText("a.ts");
  });

  it("leaves a gitignored folder uncompacted", async () => {
    // Compacting means reading each child directory to see whether the chain
    // continues; node_modules is the most expensive place to do that and the
    // least useful, so it keeps its own row.
    const ignored = { ...folder(ROOT, "node_modules"), ignored: true };
    bridge.dirs = {
      [ROOT]: [ignored],
      [`${ROOT}/node_modules`]: [folder(`${ROOT}/node_modules`, "only-dep")],
    };
    mountProject();

    await screen.findByText("node_modules");
    expect(readsOf(`${ROOT}/node_modules`)).toHaveLength(0);
  });

  // Compact folders is the first setting to go through the three-layer
  // resolution, and this is the arrow nothing else checks: the layering is unit
  // tested and the panel writes the overlay, but a tree still reading
  // `settings.editorDefaults` would leave both of those green and the setting
  // inert in the one place it is supposed to act.
  it("follows this workspace's answer over the user's", async () => {
    bridge.dirs = {
      [ROOT]: [folder(ROOT, "pkg")],
      [`${ROOT}/pkg`]: [folder(`${ROOT}/pkg`, "inner")],
      [`${ROOT}/pkg/inner`]: [file(`${ROOT}/pkg/inner`, "thing.ts")],
    };
    // The user says compact (which is also the default); this workspace says no.
    bridge.overlay = { compactFolders: false };
    await loadWorkspaceSettings(ROOT);
    mountProject();

    await screen.findByText("pkg");
    expect(screen.queryByText("pkg/inner")).toBeNull();
  });
});

describe("the undo contract", () => {
  // What the editor listens on to repoint its tabs and carry their buffers.
  function renameEvents() {
    const seen: { from: string; to: string }[] = [];
    const onRenamed = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("sway:file-renamed", onRenamed);
    return { seen, stop: () => window.removeEventListener("sway:file-renamed", onRenamed) };
  }

  function toasts() {
    const seen: { message: string; action?: { label: string; run: () => void } }[] = [];
    const onToast = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("sway:toast", onToast);
    return { seen, stop: () => window.removeEventListener("sway:toast", onToast) };
  }

  it("announces a rename so open tabs can follow it", async () => {
    const renames = renameEvents();
    mountProject({ askText: answering("guide.md") });
    await screen.findByText("README.md");

    fireEvent.contextMenu(screen.getByText("README.md"));
    pointerClick(await screen.findByText("Rename"));

    await waitFor(() => expect(renames.seen).toHaveLength(1));
    expect(renames.seen[0]).toEqual({ from: `${ROOT}/README.md`, to: `${ROOT}/guide.md` });
    renames.stop();
  });

  it("offers an undo that renames the file back", async () => {
    const notices = toasts();
    const renames = renameEvents();
    mountProject({ askText: answering("guide.md") });
    await screen.findByText("README.md");

    fireEvent.contextMenu(screen.getByText("README.md"));
    pointerClick(await screen.findByText("Rename"));
    await waitFor(() => expect(notices.seen.some((t) => t.action)).toBe(true));

    const undo = notices.seen.find((t) => t.action)?.action;
    expect(undo?.label).toBe("Undo");
    undo!.run();

    // The reverse is a rename in the other direction, announced the same way so
    // the tabs that followed the first one come back with it.
    await waitFor(() => expect(sent("fs_rename")).toHaveLength(2));
    expect(sent("fs_rename")[1].args).toMatchObject({
      from: `${ROOT}/guide.md`,
      to: `${ROOT}/README.md`,
    });
    await waitFor(() => expect(renames.seen).toHaveLength(2));
    expect(renames.seen[1]).toEqual({ from: `${ROOT}/guide.md`, to: `${ROOT}/README.md` });

    // One level only: undoing must not itself offer an undo, or a stray click
    // could walk the file back and forth through a history nobody tracks.
    const undosAfter = notices.seen.filter((t) => t.action);
    expect(undosAfter).toHaveLength(1);
    notices.stop();
    renames.stop();
  });

  it("offers the same undo after a drag-move", async () => {
    const notices = toasts();
    mountProject();
    await screen.findByText("README.md");

    const dt = dataTransfer();
    fireEvent.dragStart(rowFor("README.md"), { dataTransfer: dt });
    fireEvent.drop(rowFor("src"), { dataTransfer: dt });
    // The offer arrives after both ends of the move have been re-read, so
    // waiting on the rename call alone would race it.
    await waitFor(() => expect(notices.seen.some((t) => t.action)).toBe(true));

    notices.seen.find((t) => t.action)!.action!.run();

    await waitFor(() => expect(sent("fs_rename")).toHaveLength(2));
    expect(sent("fs_rename")[1].args).toMatchObject({
      from: `${ROOT}/src/README.md`,
      to: `${ROOT}/README.md`,
    });
    notices.stop();
  });

  it("says so rather than failing silently when an undo cannot land", async () => {
    const notices = toasts();
    mountProject({ askText: answering("guide.md") });
    await screen.findByText("README.md");

    fireEvent.contextMenu(screen.getByText("README.md"));
    pointerClick(await screen.findByText("Rename"));
    await waitFor(() => expect(notices.seen.some((t) => t.action)).toBe(true));

    // Something took the old name back in the meantime, so the reverse refuses.
    bridge.failRename = true;
    notices.seen.find((t) => t.action)!.action!.run();

    await waitFor(() => expect(notices.seen.some((t) => /Could not undo/.test(t.message))).toBe(true));
    notices.stop();
  });
});

describe("selecting and revealing", () => {
  const cmdClick = (name: string) => fireEvent.click(rowFor(name), { metaKey: true });

  it("deletes every selected row, not just the one the menu opened on", async () => {
    const askConfirm = confirming(true);
    mountProject({ askConfirm });
    await screen.findByText("README.md");

    cmdClick("README.md");
    cmdClick("docs");

    fireEvent.contextMenu(screen.getByText("README.md"));
    pointerClick(await screen.findByText("Delete"));

    await waitFor(() => expect(sent("fs_delete")).toHaveLength(2));
    expect(sent("fs_delete").map((c) => c.args.path)).toEqual([`${ROOT}/README.md`, `${ROOT}/docs`]);
    // The count has to be in the prompt, or the dialog understates the damage.
    expect((askConfirm.mock.calls[0][0] as { title: string }).title).toContain("2");
  });

  it("acts on the clicked row alone when it is outside the selection", async () => {
    mountProject();
    await screen.findByText("README.md");

    cmdClick("docs");
    fireEvent.contextMenu(screen.getByText("README.md"));
    pointerClick(await screen.findByText("Delete"));

    await waitFor(() => expect(sent("fs_delete")).toHaveLength(1));
    expect(sent("fs_delete")[0].args.path).toBe(`${ROOT}/README.md`);
  });

  it("cmd-click selects without opening the file, plain click opens and clears", async () => {
    mountProject();
    await screen.findByText("README.md");

    // Compaction already peeked at `src` to see whether it was a single-child
    // chain, so the baseline is not zero; what matters is that selecting adds
    // nothing to it. Selecting must not open: a five-file selection would
    // otherwise open five tabs.
    const before = readsOf(`${ROOT}/src`).length;
    cmdClick("src");
    await Promise.resolve();
    expect(readsOf(`${ROOT}/src`).length).toBe(before);

    fireEvent.click(rowFor("src"));
    await waitFor(() => expect(readsOf(`${ROOT}/src`).length).toBeGreaterThan(before));
  });

  it("walks the lazily-loaded tree to the active file and scrolls to it", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    mountProject({ activePath: `${ROOT}/src/main.ts` });
    await screen.findByText("README.md");
    // `src` is collapsed, so the target's row does not exist yet.
    expect(screen.queryByText("main.ts")).toBeNull();

    fireEvent.click(screen.getByLabelText("Reveal"));

    // The intervening directory opens itself, which is what makes the row exist.
    await screen.findByText("main.ts");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it("walks to the file on its own when the focus moves to another one", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const [path, setPath] = createSignal<string | null>(null);
    render(() => <FileTree root={ROOT} activePath={path()} />);
    await screen.findByText("README.md");
    expect(screen.queryByText("main.ts")).toBeNull();

    // What another pane taking focus looks like from here. Nobody clicked
    // Reveal; the tree opens `src` and scrolls the row in by itself.
    setPath(`${ROOT}/src/main.ts`);
    await screen.findByText("main.ts");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it("stops revealing once it arrives, so a later collapse sticks", async () => {
    // The walk leaves every node listening for the target. If that target were
    // left set, collapsing an ancestor would unmount these rows and remounting
    // them would replay the cascade, re-opening the chain just closed.
    Element.prototype.scrollIntoView = vi.fn();
    mountProject({ activePath: `${ROOT}/src/main.ts` });
    await screen.findByText("README.md");

    fireEvent.click(screen.getByLabelText("Reveal"));
    await screen.findByText("main.ts");

    fireEvent.click(screen.getByLabelText("Collapse all folders"));
    await waitFor(() => expect(screen.queryByText("main.ts")).toBeNull());

    // Re-opening the folder by hand shows its children and stops there, rather
    // than the tree walking itself back to where the reveal left off.
    fireEvent.click(rowFor("src"));
    await screen.findByText("main.ts");
    expect(screen.queryByText("main.ts")).toBeTruthy();
  });

  it("offers no reveal for a synthetic tab that has no row", async () => {
    mountProject({ activePath: "sway://commit-log" });
    await screen.findByText("README.md");

    expect(screen.queryByLabelText("Reveal")).toBeNull();
  });
});

describe("the active file", () => {
  it("marks the row of the file the editor is showing, and no other", async () => {
    mountProject({ activePath: `${ROOT}/README.md` });
    await waitFor(() => expect(screen.getByText("README.md")).toBeTruthy());

    const marked = document.querySelectorAll(`.${styles.active}`);
    expect(marked.length).toBe(1);
    expect(marked[0].textContent).toContain("README.md");
  });

  it("follows the file across a change of pane focus, since it is handed one path", async () => {
    const [path, setPath] = createSignal(`${ROOT}/README.md`);
    render(() => <FileTree root={ROOT} activePath={path()} />);
    await waitFor(() => expect(screen.getByText("README.md")).toBeTruthy());
    fireEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.getByText("main.ts")).toBeTruthy());

    // What the other pane taking focus looks like from here.
    setPath(`${ROOT}/src/main.ts`);
    await waitFor(() => {
      const marked = document.querySelectorAll(`.${styles.active}`);
      expect(marked.length).toBe(1);
      expect(marked[0].textContent).toContain("main.ts");
    });
  });
});

describe("dragging in the tree", () => {
  it("moves a file into the folder it is dropped on, with no git involved", async () => {
    mountProject();
    await screen.findByText("README.md");

    const dt = dataTransfer();
    fireEvent.dragStart(rowFor("README.md"), { dataTransfer: dt });
    fireEvent.dragOver(rowFor("src"), { dataTransfer: dt });
    expect(dt.dropEffect).toBe("move");
    fireEvent.drop(rowFor("src"), { dataTransfer: dt });

    await waitFor(() => expect(sent("fs_rename")).toHaveLength(1));
    expect(sent("fs_rename")[0].args).toEqual({
      root: ROOT,
      from: `${ROOT}/README.md`,
      to: `${ROOT}/src/README.md`,
      noun: "project folder",
    });
    // The manual-git invariant: a move is a plain fs rename, so the change shows
    // up as a deletion plus an untracked add until the user stages it.
    expect(bridge.calls.some((c) => /git/i.test(c.cmd))).toBe(false);
  });

  it("re-reads both ends of a move, not just the folder that received it", async () => {
    mountProject();
    await screen.findByText("README.md");
    const before = readsOf(ROOT).length;

    const dt = dataTransfer();
    fireEvent.dragStart(rowFor("README.md"), { dataTransfer: dt });
    fireEvent.drop(rowFor("src"), { dataTransfer: dt });

    await waitFor(() => expect(sent("fs_rename")).toHaveLength(1));
    // The source's parent is the root here; without re-reading it the moved file
    // would still be listed in the place it left.
    await waitFor(() => expect(readsOf(ROOT).length).toBeGreaterThan(before));
    await waitFor(() => expect(readsOf(`${ROOT}/src`).length).toBeGreaterThan(0));
  });

  it("still hands the chat composer its @path mention, and moves nothing", async () => {
    mountProject();
    await screen.findByText("README.md");

    const dt = dataTransfer();
    fireEvent.dragStart(rowFor("README.md"), { dataTransfer: dt });

    // What Composer.tsx and TerminalView.tsx read. If a move-only drag stopped
    // setting this, dragging a file into chat would silently stop mentioning it.
    expect(dt.getData("application/x-sway-path")).toBe(`${ROOT}/README.md`);
    // Both meanings stay on the table; the drop target decides which happens.
    expect(dt.effectAllowed).toBe("copyMove");

    // Releasing outside any tree drop zone moves nothing: the composer's own
    // drop handler never calls fs_rename, and neither does anything here.
    fireEvent.dragEnd(rowFor("README.md"), { dataTransfer: dt });
    expect(sent("fs_rename")).toHaveLength(0);
  });

  it("ignores a drag that is not its own, so a tab drag cannot move a file", async () => {
    mountProject();
    await screen.findByText("README.md");

    // The editor's tab strip sets only the mention type.
    const dt = dataTransfer();
    dt.setData("application/x-sway-path", "/elsewhere/other.ts");
    fireEvent.dragOver(rowFor("src"), { dataTransfer: dt });
    expect(dt.dropEffect).toBe("");
    fireEvent.drop(rowFor("src"), { dataTransfer: dt });

    await waitFor(() => expect(sent("fs_rename")).toHaveLength(0));
  });

  it("marks no drag as movable when the tree is read-only", async () => {
    render(() => <FileTree root={ROOT} />);
    await screen.findByText("README.md");

    const dt = dataTransfer();
    fireEvent.dragStart(rowFor("README.md"), { dataTransfer: dt });

    expect(dt.getData("application/x-sway-tree-move")).toBe("");
    expect(dt.effectAllowed).toBe("copy");
  });

  it("refuses to move a folder inside itself", async () => {
    mountProject();
    fireEvent.click(await screen.findByText("src"));
    await screen.findByText("utils");

    const dt = dataTransfer();
    fireEvent.dragStart(rowFor("src"), { dataTransfer: dt });
    fireEvent.drop(rowFor("utils"), { dataTransfer: dt });

    await waitFor(() => expect(sent("fs_rename")).toHaveLength(0));
  });

  it("treats a drop back into the current parent as a no-op", async () => {
    mountProject();
    fireEvent.click(await screen.findByText("src"));
    await screen.findByText("main.ts");

    const dt = dataTransfer();
    fireEvent.dragStart(rowFor("main.ts"), { dataTransfer: dt });
    fireEvent.drop(rowFor("src"), { dataTransfer: dt });

    await waitFor(() => expect(sent("fs_rename")).toHaveLength(0));
  });

  it("drops onto a file's own directory, not the workspace root", async () => {
    // A file is not a container, so it stands for the folder holding it. If this
    // fell through to the tree background instead, a file dropped beside a
    // deeply nested sibling would fly to the top of the project.
    mountProject();
    fireEvent.click(await screen.findByText("src"));
    await screen.findByText("main.ts");

    const dt = dataTransfer();
    fireEvent.dragStart(rowFor("README.md"), { dataTransfer: dt });
    fireEvent.drop(rowFor("main.ts"), { dataTransfer: dt });

    await waitFor(() => expect(sent("fs_rename")).toHaveLength(1));
    expect(sent("fs_rename")[0].args).toMatchObject({
      from: `${ROOT}/README.md`,
      to: `${ROOT}/src/README.md`,
    });
  });

  it("moves back out to the workspace root when dropped on the background", async () => {
    const { container } = mountProject();
    fireEvent.click(await screen.findByText("src"));
    await screen.findByText("main.ts");

    const dt = dataTransfer();
    fireEvent.dragStart(rowFor("main.ts"), { dataTransfer: dt });
    fireEvent.drop(container.firstChild as HTMLElement, { dataTransfer: dt });

    await waitFor(() => expect(sent("fs_rename")).toHaveLength(1));
    expect(sent("fs_rename")[0].args).toMatchObject({
      from: `${ROOT}/src/main.ts`,
      to: `${ROOT}/main.ts`,
    });
  });
});

// Written against the hand-rolled menu (skarif2/sway#103, phase 1), now running
// against Kobalte's (phase 3). Every assertion below is the one phase 1 wrote:
// what a right-click menu *does* was chosen to survive the change, and it did.
// Where it opens is pinned in `ContextMenu.test.tsx` instead, since no position
// assertion could span both implementations.
//
// What the migration actually had to rewrite here, against phase 1's list:
//   - `role="menu"` on the surface: unchanged, Kobalte's Content sets it too.
//   - `within(menu).getByText(...)`: unchanged, the labels are the contract.
//   - Escape: unchanged, though it is now the dismissable layer answering.
//   - The outside click had to become `pointerDown`. Popover listened for
//     `mousedown`, Kobalte's dismissable layer listens for `pointerdown`, which
//     is why phase 1 asserted only the closing and never the mechanism.
//   - Picking a row had to become `pointerClick`. Rows are real menu items now
//     and act on `pointerup`; see `src/test/menus.ts`.
describe("the row context menu", () => {
  it("offers a file only the actions a file has", async () => {
    mountProject();
    await screen.findByText("README.md");

    fireEvent.contextMenu(screen.getByText("README.md"));

    const m = await screen.findByRole("menu");
    expect(within(m).getByText("Rename")).toBeTruthy();
    expect(within(m).getByText("Delete")).toBeTruthy();
    // Creating happens *inside* a container, so a file offers neither. The
    // The toolbar names its icon button "New File" too, but as an aria-label;
    // this is scoped to the menu either way.
    expect(within(m).queryByText("New File")).toBeNull();
    expect(within(m).queryByText("New Folder")).toBeNull();
  });

  it("offers a folder the create actions as well", async () => {
    mountProject();
    await screen.findByText("src");

    fireEvent.contextMenu(screen.getByText("src"));

    const m = await screen.findByRole("menu");
    expect(within(m).getByText("New File")).toBeTruthy();
    expect(within(m).getByText("New Folder")).toBeTruthy();
    expect(within(m).getByText("Rename")).toBeTruthy();
    expect(within(m).getByText("Delete")).toBeTruthy();
  });

  it("closes on Escape without acting", async () => {
    mountProject();
    await screen.findByText("README.md");
    fireEvent.contextMenu(screen.getByText("README.md"));
    await screen.findByRole("menu");

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(sent("fs_rename")).toHaveLength(0);
    expect(sent("fs_delete")).toHaveLength(0);
  });

  it("closes on an outside click without acting", async () => {
    mountProject();
    await screen.findByText("README.md");
    fireEvent.contextMenu(screen.getByText("README.md"));
    await screen.findByRole("menu");
    // Kobalte installs the outside listener from a `setTimeout(0)`, so a click
    // dispatched before this yield lands on a listener that does not exist yet.
    await new Promise((resolve) => setTimeout(resolve, 0));

    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(sent("fs_rename")).toHaveLength(0);
    expect(sent("fs_delete")).toHaveLength(0);
  });

  it("closes once a row is picked, so the action runs against a shut menu", async () => {
    mountProject({ askText: answering("guide.md") });
    await screen.findByText("README.md");
    fireEvent.contextMenu(screen.getByText("README.md"));

    pointerClick(within(await screen.findByRole("menu")).getByText("Rename"));

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(sent("fs_rename")).toHaveLength(1));
  });
});

// A Feature opens N member worktrees as one tree: one section per member, each
// fenced to its own root. What is asserted here is the containment (a mutation
// carries the section's root and nothing else), and that the sections survive
// the identity churn a `features://changed` resource hands them.
describe("a Feature's member roots", () => {
  const A = "/feat/api";
  const B = "/feat/web";

  const MEMBERS: TreeRoot[] = [
    { path: A, label: "Payments API" },
    { path: B, label: "Web App" },
  ];

  const sectionOf = (path: string) => document.querySelector(`[data-root="${path}"]`) as HTMLElement;
  const backgroundOf = (path: string) =>
    sectionOf(path).querySelector(`.${styles.sectionBody}`) as HTMLElement;

  function mountFeature(overrides: Record<string, unknown> = {}) {
    return render(() => (
      <FileTree
        root={null}
        roots={MEMBERS}
        editable
        noun="member folder"
        askText={answering("ignored")}
        askConfirm={confirming(true)}
        {...overrides}
      />
    ));
  }

  function toasts() {
    const seen: { message: string }[] = [];
    const onToast = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("sway:toast", onToast);
    return { seen, stop: () => window.removeEventListener("sway:toast", onToast) };
  }

  beforeEach(() => {
    // Both members carry a `src`, so nothing below can pass by matching a name
    // that happens to be unique.
    bridge.dirs = {
      [A]: [folder(A, "src"), file(A, "README.md")],
      [`${A}/src`]: [file(`${A}/src`, "main.ts")],
      [B]: [folder(B, "src"), file(B, "package.json")],
      [`${B}/src`]: [file(`${B}/src`, "app.ts")],
    };
  });

  it("refreshes only the section whose root the burst names, once per burst", async () => {
    mountFeature();
    await within(sectionOf(A)).findByText("README.md");
    await within(sectionOf(B)).findByText("package.json");
    bridge.calls = [];

    // Three events, one root, one reload: the same debounce every other
    // `fs://changed` consumer sits behind.
    fsChanged(B, [`${B}/package.json`]);
    fsChanged(B, [`${B}/src/app.ts`]);
    fsChanged(B, [`${B}/src/new.ts`]);
    await waitFor(() => expect(readsOf(B)).toHaveLength(1), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 250));
    expect(readsOf(B)).toHaveLength(1);
    expect(readsOf(A)).toHaveLength(0);
  });

  it("keeps its sections when the roots array is rebuilt with the same paths", async () => {
    // `features://changed` fires once per member while a Feature is being
    // created, and a resource hands back fresh objects every time. Keyed on
    // those objects, every section would remount and lose what it had open.
    const [roots, setRoots] = createSignal<TreeRoot[]>([...MEMBERS]);
    render(() => <FileTree root={null} roots={roots()} />);
    await within(sectionOf(A)).findByText("README.md");
    fireEvent.click(within(sectionOf(A)).getByText("src"));
    await within(sectionOf(A)).findByText("main.ts");
    const reads = sent("fs_read_dir_compact").length;

    setRoots(MEMBERS.map((m) => ({ ...m })));
    await new Promise((r) => setTimeout(r, 0));

    expect(sent("fs_read_dir_compact")).toHaveLength(reads);
    expect(within(sectionOf(A)).getByText("main.ts")).toBeTruthy();
  });

  it("fences every mutation to the section it was made in", async () => {
    mountFeature({ askText: answering("moved") });
    await within(sectionOf(B)).findByText("package.json");

    fireEvent.click(within(sectionOf(B)).getByLabelText("New Folder in Web App"));
    await waitFor(() => expect(sent("fs_mkdir")).toHaveLength(1));
    expect(sent("fs_mkdir")[0].args).toMatchObject({ root: B, path: `${B}/moved` });

    fireEvent.contextMenu(within(sectionOf(B)).getByText("package.json"));
    pointerClick(await screen.findByText("Rename"));
    await waitFor(() => expect(sent("fs_rename")).toHaveLength(1));
    expect(sent("fs_rename")[0].args).toMatchObject({ root: B, from: `${B}/package.json` });

    fireEvent.contextMenu(within(sectionOf(B)).getByText("src"));
    pointerClick(await screen.findByText("Delete"));
    await waitFor(() => expect(sent("fs_delete")).toHaveLength(1));
    expect(sent("fs_delete")[0].args).toMatchObject({ root: B, path: `${B}/src` });
  });

  it("moves back out to the section's own root when dropped on its background", async () => {
    mountFeature();
    await within(sectionOf(A)).findByText("README.md");
    fireEvent.click(within(sectionOf(A)).getByText("src"));
    await within(sectionOf(A)).findByText("main.ts");

    const dt = dataTransfer();
    fireEvent.dragStart(within(sectionOf(A)).getByText("main.ts").parentElement!, { dataTransfer: dt });
    fireEvent.drop(backgroundOf(A), { dataTransfer: dt });

    await waitFor(() => expect(sent("fs_rename")).toHaveLength(1));
    expect(sent("fs_rename")[0].args).toMatchObject({
      root: A,
      from: `${A}/src/main.ts`,
      to: `${A}/main.ts`,
    });
  });

  it("refuses a move across roots before any command goes out", async () => {
    const notices = toasts();
    mountFeature();
    await within(sectionOf(A)).findByText("README.md");
    await within(sectionOf(B)).findByText("package.json");

    const dt = dataTransfer();
    fireEvent.dragStart(within(sectionOf(A)).getByText("README.md").parentElement!, { dataTransfer: dt });
    fireEvent.drop(backgroundOf(B), { dataTransfer: dt });

    await waitFor(() => expect(notices.seen).toHaveLength(1));
    expect(notices.seen[0].message).toContain("member folder");
    expect(sent("fs_rename")).toHaveLength(0);
    notices.stop();
  });

  it("reveals into the root that owns the file and leaves the others shut", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    mountFeature({ activePath: `${B}/src/app.ts` });
    await within(sectionOf(A)).findByText("README.md");
    expect(screen.queryByText("app.ts")).toBeNull();

    fireEvent.click(screen.getByLabelText("Reveal"));

    await within(sectionOf(B)).findByText("app.ts");
    expect(within(sectionOf(A)).queryByText("main.ts")).toBeNull();
  });

  it("filters each root on its own and keeps both sections under their chips", async () => {
    bridge.filesByRoot = { [A]: ["src/config.ts"], [B]: ["lib/config.ts"] };
    mountFeature();
    await within(sectionOf(A)).findByText("README.md");

    fireEvent.input(screen.getByLabelText("Filter files"), { target: { value: "config" } });

    await within(sectionOf(A)).findByText("src/config.ts");
    await within(sectionOf(B)).findByText("lib/config.ts");
    expect(sent("list_project_files").map((c) => c.args.projectPath).sort()).toEqual([A, B]);
    expect(sectionOf(A).querySelector("[data-chip]")!.textContent).toBe("PA");
    expect(sectionOf(B).querySelector("[data-chip]")!.textContent).toBe("WA");
  });

  it("offers a repair instead of a tree for a member with no worktree", async () => {
    const onRetry = vi.fn();
    mountFeature({
      roots: [
        MEMBERS[0],
        { ...MEMBERS[1], state: memberState({ kind: "worktree-missing" }) },
      ],
      onRetry,
    });
    await within(sectionOf(A)).findByText("README.md");

    expect(within(sectionOf(B)).queryByText("package.json")).toBeNull();
    expect(within(sectionOf(B)).getByText("Worktree missing")).toBeTruthy();
    fireEvent.click(sectionOf(B).querySelector("[data-repair]") as HTMLElement);
    expect(onRetry).toHaveBeenCalledWith(B);
  });

  it("loads a repaired member, which never changed path and so never remounted", async () => {
    const [state, setState] = createSignal(memberState({ kind: "worktree-missing" }));
    render(() => <FileTree root={null} roots={[MEMBERS[0], { ...MEMBERS[1], state: state() }]} />);
    await within(sectionOf(A)).findByText("README.md");
    expect(within(sectionOf(B)).queryByText("package.json")).toBeNull();

    setState(memberState({ kind: "present" }));

    await within(sectionOf(B)).findByText("package.json");
  });

  it("draws no section chrome for a lone root", async () => {
    render(() => (
      <FileTree
        root={A}
        editable
        noun="member folder"
        askText={answering(null)}
        askConfirm={confirming(true)}
      />
    ));
    await screen.findByText("README.md");

    expect(document.querySelector(`.${styles.sectionHeader}`)).toBeNull();
    expect(screen.getByLabelText("New File")).toBeTruthy();
  });
});

describe("the file tree, to axe", () => {
  it("has no accessibility violations", async () => {
    mountProject();
    await screen.findByText("README.md");

    // `document.body`, not the render container: a tooltip portals out of it.
    await expectNoAxeViolations(document.body);
  });

  it("has none once it grows section headers either", async () => {
    bridge.dirs = {
      "/feat/api": [file("/feat/api", "README.md")],
      "/feat/web": [file("/feat/web", "package.json")],
    };
    render(() => (
      <FileTree
        root={null}
        roots={[
          { path: "/feat/api", label: "Payments API" },
          { path: "/feat/web", label: "Web App", state: memberState({ kind: "worktree-missing" }) },
        ]}
        editable
        noun="member folder"
        askText={answering(null)}
        askConfirm={confirming(true)}
      />
    ));
    await screen.findByText("README.md");

    await expectNoAxeViolations(document.body);
  });
});
