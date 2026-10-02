// The member chip rows inside a Topic (#160 phase 3). Pull requests wears the
// right panel's row, which moves `activeRoot`; the Files tab wears its own, and
// its Scripts section is the pane that visibly reloads for the member picked.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor, cleanup } from "@solidjs/testing-library";
import { installAnimationFrame } from "../../test/frames";
import { pointerClick } from "../../test/menus";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

installAnimationFrame();

/** A bare container: its worktrees sit beside it, and `.shared/` is linked in. */
const API_REPO = "/w/api";
const API = `${API_REPO}/auth`;
/** A plain repo: its Topic worktree sits under `.tori/worktrees`, where no
 *  `.shared/` is linked. */
const WEB_REPO = "/w/web";
const WEB = `${WEB_REPO}/.tori/worktrees/auth`;

const member = (repoPath: string, displayName: string, worktreePath: string | null, order: number) => ({
  repoPath,
  displayName,
  worktreePath,
  state: worktreePath ? { kind: "present" } : { kind: "worktree-missing" },
  order,
});

let TOPIC_MEMBERS: ReturnType<typeof member>[] = [];

const SPACES = [
  {
    name: "work",
    color: "Sky",
    projects: [
      {
        name: "api",
        path: API_REPO,
        // No unit at the container itself: every unit is a worktree beside it.
        branchUnits: [{ folderPath: API, kind: "worktree" }],
      },
      {
        name: "web",
        path: WEB_REPO,
        // The Topic worktree is listed first on purpose: #158 made a plain
        // repo report its contained worktrees, so position says nothing.
        branchUnits: [
          { folderPath: WEB, kind: "worktree" },
          { folderPath: WEB_REPO, kind: "plain" },
        ],
      },
    ],
  },
];

type Invoke = { cmd: string; args: Record<string, unknown> };
const calls: Invoke[] = [];
/** Paths `file_exists` answers true for. */
let present = new Set<string>();
/** When set, `file_exists` for this path parks until released, so a slower
 *  probe can be made to answer after a newer one. */
let park: { path: string; release: () => void } | null = null;
/** `package.json` scripts per root, so a Tasks reload is observable. */
let scripts: Record<string, Record<string, string>> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    const a = args ?? {};
    calls.push({ cmd, args: a });
    switch (cmd) {
      case "list_topics":
        return Promise.resolve([
          { id: "f1", name: "Auth", branch: "feat/auth", createdAt: 1, members: TOPIC_MEMBERS },
        ]);
      case "get_config":
        return Promise.resolve({ spaces: SPACES });
      case "file_exists": {
        const path = a.path as string;
        const answer = present.has(path);
        if (park?.path === path) {
          return new Promise((resolve) => {
            park!.release = () => resolve(answer);
          });
        }
        return Promise.resolve(answer);
      }
      case "fs_read_dir":
        return Promise.resolve(
          scripts[a.path as string] ? [{ name: "package.json" }] : [],
        );
      case "fs_read_file": {
        const root = String(a.path).replace(/\/package\.json$/, "");
        return Promise.resolve(JSON.stringify({ scripts: scripts[root] ?? {} }));
      }
      case "git_status":
      case "list_branches":
      case "list_project_files":
      case "fs_read_dir_compact":
        return Promise.resolve([]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: false });
      case "git_conflict_op":
        return Promise.resolve("none");
      default:
        return Promise.resolve(null);
    }
  },
  Channel: class {
    onmessage: ((m: string) => void) | null = null;
  },
}));
// `createTopicMembers` reads `list_topics` once per generation, module-wide,
// and only a `topics://changed` bumps the generation. Without the handler a
// later test would render the first test's member list out of that cache.
const topicHandlers = vi.hoisted(() => [] as (() => void)[]);
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: () => void) => {
    if (name === "topics://changed") topicHandlers.push(cb);
    return Promise.resolve(() => {});
  },
}));
const listening = { ready: false };
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => {
      listening.ready = true;
      return Promise.resolve(() => {});
    },
  }),
}));
vi.mock("./CodeEditor", () => ({ default: () => null }));
vi.mock("./lspClient", () => ({
  stopAllLsp: () => Promise.resolve(),
  stopEvictedLspRoots: () => Promise.resolve(),
}));

const { default: Editor } = await import("./Editor");
const { emitWith, SET_RIGHT_MODE } = await import("../../utils/events");

const topicSel = (activeRoot: string) => ({
  kind: "topic" as const,
  topicId: "f1",
  topicName: "Auth",
  roots: TOPIC_MEMBERS.map((m) => m.worktreePath).filter(Boolean),
  activeRoot,
  spaceName: "",
  projectName: "Auth",
  projectPath: activeRoot,
  folderPath: activeRoot,
  branch: "feat/auth",
  projectKind: "topic",
});

/** Mount with the chip row wired to the same handler App gives it, so clicking
 *  a chip really moves the selection. */
async function mountEditor(initial = API) {
  for (const bump of topicHandlers) bump();
  const [sel, set] = createSignal<unknown>(topicSel(initial));
  render(() => (
    <Editor
      selected={sel() as never}
      onActiveRoot={(root) => set(topicSel(root))}
    />
  ));
  await waitFor(() => expect(listening.ready).toBe(true));
}

const showMode = (mode: string, section?: string) => emitWith(SET_RIGHT_MODE, { mode, section });
const showScripts = () => showMode("files", "scripts");
const chip = (repoPath: string) => document.querySelector<HTMLElement>(`[data-member="${repoPath}"]`);
// The Files pane draws the members as tabs, the others as a chip group; both
// name themselves the same.
const chipRow = () => document.querySelector<HTMLElement>('[aria-label="Topic members"]');

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  listening.ready = false;
  park = null;
  scripts = {};
  present = new Set<string>();
  TOPIC_MEMBERS = [member(API_REPO, "api", API, 0), member(WEB_REPO, "web", WEB, 1)];
});

afterEach(() => {
  cleanup();
});

describe("the member tabs", () => {
  it("is drawn for the modes that answer for one member, and no others", async () => {
    await mountEditor();
    for (const mode of ["pulls", "files", "changes"]) {
      // Debug follows the file in front and names its member on a line instead,
      // so passing through it proves each row belongs to the mode that drew it.
      showMode("debug");
      await waitFor(() => expect(chipRow()).toBeNull());
      showMode(mode);
      await waitFor(() => expect(chipRow()).toBeTruthy());
    }
  });

  it("moves the active member, and the pane below reloads for it", async () => {
    scripts = { [API]: { "api:serve": "node ." }, [WEB]: { "web:dev": "vite" } };
    await mountEditor();
    showScripts();
    await waitFor(() => expect(screen.getByText("api:serve")).toBeTruthy());

    pointerClick(chip(WEB_REPO)!);

    await waitFor(() => expect(screen.getByText("web:dev")).toBeTruthy());
    expect(screen.queryByText("api:serve")).toBeNull();
  });

  it("marks the member the pane is about", async () => {
    await mountEditor();
    showMode("files");
    await waitFor(() => expect(chip(API_REPO)).toBeTruthy());
    expect(chip(API_REPO)!.getAttribute("aria-selected")).toBe("true");
    expect(chip(WEB_REPO)!.getAttribute("aria-selected")).toBe("false");
  });

  it("wears a broken member's state and refuses to switch to it", async () => {
    TOPIC_MEMBERS = [member(API_REPO, "api", API, 0), member(WEB_REPO, "web", null, 1)];
    await mountEditor();
    // The right panel's tabs: the Files tabs let a broken member be picked, to
    // show its repair (topicRoot.test.tsx).
    showMode("pulls");
    await waitFor(() => expect(chip(WEB_REPO)).toBeTruthy());
    const broken = chip(WEB_REPO) as HTMLButtonElement;
    expect(broken.disabled).toBe(true);
    expect(broken.getAttribute("data-state")).toBe("worktree-missing");
  });

  it("is absent with only one member, which is not a choice", async () => {
    TOPIC_MEMBERS = [member(API_REPO, "api", API, 0)];
    await mountEditor();
    showMode("files");
    await waitFor(() => expect(screen.getByLabelText("Filter files")).toBeTruthy());
    expect(chipRow()).toBeNull();
  });
});

describe("a Topic with many members", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => member(`/w/r${i}`, `r${i}`, `/w/r${i}/auth`, i));

  it("gives every member a tab in Files, however many, and switches to the last", async () => {
    TOPIC_MEMBERS = many(8);
    scripts = { "/w/r0/auth": { first: "x" }, "/w/r7/auth": { last: "y" } };
    await mountEditor("/w/r0/auth");
    showScripts();
    await waitFor(() => expect(screen.getByText("first")).toBeTruthy());
    expect(screen.getAllByRole("tab").filter((t) => t.hasAttribute("data-member"))).toHaveLength(8);

    pointerClick(chip("/w/r7")!);

    await waitFor(() => expect(screen.getByText("last")).toBeTruthy());
  });
});
