// Quick-open across a Topic's members (#158 phase 4): the box lists every
// present member, names each row's repo, and keys its frecency the way the
// editor writes it.
//
// Its own file rather than a describe in `Omnibox.test.tsx`: that suite's mock
// answers `list_project_files` with one flat array whatever root it is asked
// about, and its selection is a branch unit throughout.
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";

const A = "/r/api/.tori/worktrees/auth";
const B = "/r/web/.tori/worktrees/auth";

/** The eight-member Topic, for the caps. Twenty-six files each is the
 *  smallest fixture that puts the whole list past `MAX_RESULTS`. */
const WIDE = Array.from({ length: 8 }, (_, i) => `/r/m${i}/.tori/worktrees/auth`);
const PER_MEMBER = 26;

const bridge = vi.hoisted(() => ({
  files: {} as Record<string, string[]>,
  listed: [] as string[],
}));

const member = (repo: string, name: string, worktree: string, order: number) => ({
  repoPath: repo,
  displayName: name,
  worktreePath: worktree,
  state: { kind: "present" },
  order,
});

const TOPICS = [
  {
    id: "f1",
    name: "Auth",
    branch: "feat/auth",
    createdAt: 1,
    members: [member("/r/api", "api", A, 0), member("/r/web", "web", B, 1)],
  },
  // The same two members, the second one's worktree gone. Its files cannot be
  // listed, but they are still in the jump list and still worth naming.
  {
    id: "f1b",
    name: "Auth",
    branch: "feat/auth",
    createdAt: 3,
    members: [member("/r/api", "api", A, 0), { ...member("/r/web", "web", B, 1), state: { kind: "worktree-missing" } }],
  },
  // A second record rather than a second mock: `topicMembers` reads once per
  // generation module-wide, so a swapped payload would be served from the cache.
  {
    id: "f8",
    name: "Wide",
    branch: "feat/wide",
    createdAt: 2,
    members: WIDE.map((w, i) => member(`/r/m${i}`, `m${i}`, w, i)),
  },
];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "list_project_files") {
      const at = args.projectPath as string;
      bridge.listed.push(at);
      return Promise.resolve(bridge.files[at] ?? []);
    }
    if (cmd === "list_topics") return Promise.resolve(TOPICS);
    if (cmd === "get_config") return Promise.resolve({ spaces: [] });
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const { default: Omnibox } = await import("./Omnibox");
const { publishEditorState, clearEditorState } = await import("../../utils/editorState");
const { note, saveFrecency } = await import("../../utils/frecency");
const { OPEN_IN_EDITOR } = await import("../../utils/events");

const topicSel = (topicId: string, roots: string[]) => ({
  kind: "topic" as const,
  topicId,
  topicName: topicId === "f1" ? "Auth" : "Wide",
  roots,
  activeRoot: roots[0],
  spaceName: "",
  projectName: "Auth",
  projectPath: roots[0],
  folderPath: roots[0],
  branch: "feat/auth",
  projectKind: "topic",
});

let mounted: ReturnType<typeof render> | null = null;
const open = (sel: unknown, prefix = "") => {
  mounted = render(() => (
    <Omnibox prefix={prefix} selected={sel as never} onOpenSettings={() => {}} onClose={() => {}} />
  ));
};

const rowLabels = () => [...document.querySelectorAll('[class*="itemLabel"]')].map((el) => el.textContent ?? "");

/** Click a row and hand back what it put on the bus. */
function fire(label: string): unknown {
  let payload: unknown;
  const on = (e: Event) => (payload = (e as CustomEvent).detail);
  window.addEventListener(OPEN_IN_EDITOR, on);
  fireEvent.click(screen.getByText(label));
  window.removeEventListener(OPEN_IN_EDITOR, on);
  return payload;
}

beforeEach(() => {
  localStorage.clear();
  clearEditorState();
  bridge.listed.length = 0;
  bridge.files = {
    [A]: ["package.json", "src/a.ts"],
    [B]: ["package.json", "src/b.ts"],
  };
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  clearEditorState();
});

describe("quick-open inside a Topic", () => {
  it("offers each member's package.json as its own row, named by its repo", async () => {
    open(topicSel("f1", [A, B]));
    // Every present member listed, not only the active one.
    await waitFor(() => expect(bridge.listed).toEqual([A, B]));
    await waitFor(() => expect(rowLabels()).toEqual(expect.arrayContaining(["api/package.json", "web/package.json"])));
  });

  it("opens the row's own member, not the active root", async () => {
    open(topicSel("f1", [A, B]));
    await waitFor(() => expect(screen.getByText("web/package.json")).toBeTruthy());
    // The id and the label both carry the root, so the second `package.json` is
    // a row of its own rather than one that collides with the first.
    expect(fire("web/package.json")).toEqual({ path: `${B}/package.json`, line: undefined, col: undefined });
  });

  it("names a jump target and a worked-in file through their own member", async () => {
    // Both in the background member: labelled against the active root these
    // would fall back to absolute paths, which is what `mentionPath` does with
    // a path outside the folder it is given.
    publishEditorState({
      activePath: `${B}/src/b.ts`,
      dirty: false,
      tabCount: 1,
      projectRoot: B,
      recentJumps: [{ path: `${B}/src/b.ts` }],
    });
    saveFrecency(note({}, "topic:f1", `${B}/deep/x.ts`, "edit", Date.now()));
    open(topicSel("f1", [A, B]));

    await waitFor(() => expect(rowLabels().slice(0, 2)).toEqual(["web/src/b.ts", "web/deep/x.ts"]));
  });

  it("still names the repo of a file whose member lost its worktree", async () => {
    // `Selection.roots` has dropped this member, so a label resolved through it
    // would print the absolute path here, while the file's tab keeps saying
    // `web / b.txt`. The member record is what both of them read.
    publishEditorState({
      activePath: `${A}/src/a.ts`,
      dirty: false,
      tabCount: 1,
      projectRoot: A,
      recentJumps: [{ path: `${B}/src/b.ts` }],
    });
    open(topicSel("f1b", [A]));

    await waitFor(() => expect(rowLabels()[0]).toBe("web/src/b.ts"));
  });

  it("reads frecency under the Topic key the editor writes", async () => {
    // Noted under `topic:f1`, never under a member folder. Read by the old
    // `folderPath` key this record is invisible and there is no block at all.
    saveFrecency(note({}, "topic:f1", `${A}/src/a.ts`, "edit", Date.now()));
    open(topicSel("f1", [A, B]));

    expect(screen.getByText("Recent files")).toBeTruthy();
    // The block renders from storage on the first frame, before `list_topics`
    // has said what the repo is called, so the row gains its prefix a tick
    // later. Its id never changes, so the row itself does not move.
    await waitFor(() => expect(rowLabels()[0]).toBe("api/src/a.ts"));
    // Once, not twice: the ranked project tail drops what the block above took.
    await waitFor(() => expect(screen.getByText("api/package.json")).toBeTruthy());
    expect(rowLabels().filter((l) => l === "api/src/a.ts")).toHaveLength(1);
  });
});

describe("the result caps across eight members", () => {
  beforeEach(() => {
    bridge.files = Object.fromEntries(
      WIDE.map((w) => [w, Array.from({ length: PER_MEMBER }, (_, i) => `src/f${i}.ts`)]),
    );
  });

  it("gives every member rows when nothing is typed, past the shared cap", async () => {
    open(topicSel("f8", WIDE));
    await waitFor(() => expect(rowLabels()).toHaveLength(WIDE.length * PER_MEMBER));
    // The point of the per-root cap: a single global one would have stopped at
    // 200 and left the last member with nothing, which reads as an empty repo.
    const repos = new Set(rowLabels().map((l) => l.split("/")[0]));
    expect(repos.size).toBe(WIDE.length);
  });

  it("keeps one cap over the whole list once a query scores it", async () => {
    open(topicSel("f8", WIDE));
    await waitFor(() => expect(rowLabels().length).toBeGreaterThan(200));

    fireEvent.input(screen.getByRole("combobox"), { target: { value: "s" } });

    // Scores are comparable across members, so the best 200 really are the best
    // 200 and there is nothing for a per-root cap to protect.
    expect(rowLabels()).toHaveLength(200);
  });
});
