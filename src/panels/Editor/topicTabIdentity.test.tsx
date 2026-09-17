// A file tab inside a Topic names its repo (#158 phase 2): the chip composes
// before the seti glyph, the repo reaches the accessible name through a hidden
// span, and the `+N` rows spend their width on `<repo> / <rel path>` because the
// overflow menu is where two members' same-named files sit next to each other.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@solidjs/testing-library";

import { installResizeObserver } from "./__fixtures__/editorAgent";
import { installAnimationFrame } from "../../test/frames";
import { setTabBarWidth } from "../../test/tabLayout";
import { pointerClick } from "../../test/menus";

installResizeObserver();
installAnimationFrame();

const A = "/r/a/.tori/worktrees/auth";
const B = "/r/b/.tori/worktrees/auth";
const FILE_A = `${A}/a.txt`;
const DEEP_A = `${A}/deep/c.txt`;
const FILE_B = `${B}/src/b.txt`;

// The second member's worktree is gone, but its path is still on record: that is
// exactly the case where the tab outlives the folder and must keep saying whose
// file it is.
const TOPIC = {
  id: "f1",
  name: "Auth",
  branch: "feat/auth",
  createdAt: 1,
  members: [
    { repoPath: "/r/a", displayName: "api", worktreePath: A, state: { kind: "present" }, order: 0 },
    { repoPath: "/r/b", displayName: "web", worktreePath: B, state: { kind: "worktree-missing" }, order: 1 },
  ],
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    switch (cmd) {
      case "file_exists":
        return Promise.resolve(true);
      case "git_status":
      case "list_branches":
      case "fs_read_dir":
      case "fs_read_dir_compact":
      case "list_project_files":
        return Promise.resolve([]);
      case "list_topics":
        return Promise.resolve([TOPIC]);
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
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve(), stopEvictedLspRoots: () => Promise.resolve() }));

const { default: Editor } = await import("./Editor");
const { default: PaneView } = await import("../../tabs/PaneView");

const topicSel = {
  kind: "topic" as const,
  topicId: "f1",
  topicName: "Auth",
  roots: [A],
  activeRoot: A,
  spaceName: "",
  projectName: "Auth",
  projectPath: A,
  folderPath: A,
  branch: "feat/auth",
  projectKind: "topic",
};

const unitSel = {
  kind: "unit",
  spaceName: "work",
  projectName: "a",
  projectPath: "/r/a",
  folderPath: "/r/a",
  branch: "main",
  projectKind: "plain",
};

function openTabs(ws: string, paths: string[]) {
  localStorage.setItem(
    "tori.editor.tabs.v1",
    JSON.stringify({ [ws]: { paths, active: paths[0], savedAt: Date.now() } }),
  );
}

/** `<repo> / <basename>`, tolerant of how an engine joins a hidden span to the
 *  text beside it: the separator is what matters, not the exact spaces around
 *  it (jsdom trims each node, browsers do not). */
const NAMED = (repo: string, file: string) =>
  new RegExp(`^${repo}\\s*/\\s*${file.replace(".", "\\.")}$`);

let mounted: ReturnType<typeof render> | null = null;
const mount = (sel: unknown) => {
  mounted = render(() => (
    <>
      <Editor selected={sel as never} />
      <PaneView pinKind="file" />
    </>
  ));
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("a file tab inside a Topic", () => {
  it("names its member in the accessible name and keeps the file glyph beside the chip", async () => {
    openTabs("topic:f1", [FILE_A]);
    mount(topicSel);
    const tab = await screen.findByRole("tab", { name: NAMED("api", "a.txt") });
    // Composed, not substituted: the chip says which repo, the seti glyph still
    // says which kind of file.
    expect(tab.querySelector("[data-chip]")).toBeTruthy();
    expect(tab.querySelector(".seti-icon")).toBeTruthy();
    // The chip itself is silent; the hidden span is what carries the repo.
    expect(tab.querySelector("[data-chip]")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps the chip on a member whose worktree is gone, and wears the state", async () => {
    openTabs("topic:f1", [FILE_B]);
    mount(topicSel);
    const tab = await screen.findByRole("tab", { name: NAMED("web", "b.txt") });
    expect(tab.querySelector("[data-chip]")?.getAttribute("data-state")).toBe("worktree-missing");
  });

  it("hands the crumb bar the same member, which is not the active root", async () => {
    // The wiring, not the bar: `Breadcrumbs` is tested on its own with a member
    // handed to it, and this is the one line that says where that member comes
    // from. The file is in the background member, so a trail resolved against
    // `activeRoot` would collapse to the basename.
    openTabs("topic:f1", [FILE_B]);
    mount(topicSel);
    const crumbs = within(await screen.findByRole("navigation", { name: "Breadcrumbs" }));
    await waitFor(() => expect(crumbs.getByRole("button", { name: "web" })).toBeTruthy());
    // The whole trail, not just its head: against `activeRoot` there would have
    // been one crumb here, and it would have been the basename. Counted by the
    // crumb class rather than by every button in the bar, which now ends in the
    // file's own controls (blame, preview).
    expect(
      crumbs.getAllByRole("button").filter((b) => /crumb/.test(b.className)),
    ).toHaveLength(3);
    expect(crumbs.getByRole("button", { name: "src" })).toBeTruthy();
    expect(crumbs.getByRole("button", { name: "b.txt" })).toBeTruthy();
  });

  it("leaves a branch unit's tab exactly as it was, chipless", async () => {
    openTabs("/r/a", ["/r/a/a.txt"]);
    mount(unitSel);
    const tab = await screen.findByRole("tab", { name: "a.txt" });
    expect(tab.querySelector("[data-chip]")).toBeNull();
  });

  it("spells out <repo> / <rel path> on every overflow row", async () => {
    // 150px fits one 120px tab once the +N button is reserved, so two collapse.
    setTabBarWidth(150);
    openTabs("topic:f1", [FILE_A, FILE_B, DEEP_A]);
    mount(topicSel);
    pointerClick(await screen.findByRole("button", { name: "2 more" }));
    const menu = await waitFor(() => screen.getByRole("menu"));
    expect(menu.textContent).toContain("web / src/b.txt");
    expect(menu.textContent).toContain("api / deep/c.txt");
  });
});
