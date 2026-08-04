import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

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
} = { calls: [], dirs: {}, existing: new Set(), failRename: false, projectFiles: [] };

const sent = (cmd: string) => bridge.calls.filter((c) => c.cmd === cmd);
const readsOf = (path: string) => sent("fs_read_dir").filter((c) => c.args.path === path);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    bridge.calls.push({ cmd, args });
    if (cmd === "fs_read_dir") return Promise.resolve(bridge.dirs[args.path as string] ?? []);
    if (cmd === "list_project_files") return Promise.resolve(bridge.projectFiles);
    if (cmd === "file_exists") return Promise.resolve(bridge.existing.has(args.path as string));
    if (cmd === "fs_rename" && bridge.failRename)
      return Promise.reject("A file or folder with that name already exists.");
    return Promise.resolve(null);
  },
}));

import FileTree from "./FileTree";

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

beforeEach(() => {
  bridge.calls = [];
  bridge.existing = new Set();
  bridge.failRename = false;
  bridge.projectFiles = [];
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

    fireEvent.click(screen.getByText("New File"));

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

    fireEvent.click(screen.getByText("New File"));

    await waitFor(() => expect(sent("file_exists")).toHaveLength(1));
    // The whole point: an existing name opens the file rather than truncating it.
    expect(sent("fs_write_file")).toHaveLength(0);
  });

  it("renames through the fenced command, keeping the file in its own directory", async () => {
    mountProject({ askText: answering("guide.md") });
    await screen.findByText("README.md");

    fireEvent.contextMenu(screen.getByText("README.md"));
    fireEvent.click(await screen.findByText("Rename"));

    await waitFor(() => expect(sent("fs_rename")).toHaveLength(1));
    expect(sent("fs_rename")[0].args).toEqual({
      root: ROOT,
      from: `${ROOT}/README.md`,
      to: `${ROOT}/guide.md`,
      noun: "project folder",
    });
  });

  it("deletes only after a confirmation, and fences the delete to the root", async () => {
    const askConfirm = confirming(true);
    mountProject({ askConfirm });
    await screen.findByText("README.md");

    fireEvent.contextMenu(screen.getByText("README.md"));
    fireEvent.click(await screen.findByText("Delete"));

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
    fireEvent.click(await screen.findByText("Delete"));

    await waitFor(() => expect(screen.queryByText("Delete")).toBeNull());
    expect(sent("fs_delete")).toHaveLength(0);
  });

  it("offers no mutating affordances when it is not editable", async () => {
    render(() => <FileTree root={ROOT} />);
    await screen.findByText("README.md");

    expect(screen.queryByText("New File")).toBeNull();
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
    fireEvent.click(await screen.findByText("Rename"));

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
    fireEvent.click(await screen.findByText("Rename"));
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
    fireEvent.click(await screen.findByText("Rename"));
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
    fireEvent.click(await screen.findByText("Delete"));

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
    fireEvent.click(await screen.findByText("Delete"));

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

    fireEvent.click(screen.getByText("Reveal"));

    // The intervening directory opens itself, which is what makes the row exist.
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

    fireEvent.click(screen.getByText("Reveal"));
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

    expect(screen.queryByText("Reveal")).toBeNull();
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
