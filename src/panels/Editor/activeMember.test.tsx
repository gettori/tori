// The member chip rows inside a Feature (#160 phase 3). Pull requests wears the
// right panel's row, which moves `activeRoot`; the Files tab wears its own, and
// its Scripts section is the pane that visibly reloads for the member picked.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent, cleanup } from "@solidjs/testing-library";
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
/** A plain repo: its Feature worktree sits under `.sway/worktrees`, where no
 *  `.shared/` is linked. */
const WEB_REPO = "/w/web";
const WEB = `${WEB_REPO}/.sway/worktrees/auth`;

const member = (repoPath: string, displayName: string, worktreePath: string | null, order: number) => ({
  repoPath,
  displayName,
  worktreePath,
  state: worktreePath ? { kind: "present" } : { kind: "worktree-missing" },
  order,
});

let FEATURE_MEMBERS: ReturnType<typeof member>[] = [];

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
        // The Feature worktree is listed first on purpose: #158 made a plain
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
      case "list_features":
        return Promise.resolve([
          { id: "f1", name: "Auth", branch: "feat/auth", createdAt: 1, members: FEATURE_MEMBERS },
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
      default:
        return Promise.resolve(null);
    }
  },
  Channel: class {
    onmessage: ((m: string) => void) | null = null;
  },
}));
// `createFeatureMembers` reads `list_features` once per generation, module-wide,
// and only a `features://changed` bumps the generation. Without the handler a
// later test would render the first test's member list out of that cache.
const featureHandlers = vi.hoisted(() => [] as (() => void)[]);
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: () => void) => {
    if (name === "features://changed") featureHandlers.push(cb);
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

const featureSel = (activeRoot: string) => ({
  kind: "feature" as const,
  featureId: "f1",
  featureName: "Auth",
  roots: FEATURE_MEMBERS.map((m) => m.worktreePath).filter(Boolean),
  activeRoot,
  spaceName: "",
  projectName: "Auth",
  projectPath: activeRoot,
  folderPath: activeRoot,
  branch: "feat/auth",
  projectKind: "feature",
});

/** Mount with the chip row wired to the same handler App gives it, so clicking
 *  a chip really moves the selection. */
async function mountEditor(initial = API) {
  for (const bump of featureHandlers) bump();
  const [sel, set] = createSignal<unknown>(featureSel(initial));
  render(() => (
    <Editor
      selected={sel() as never}
      onActiveRoot={(root) => set(featureSel(root))}
    />
  ));
  await waitFor(() => expect(listening.ready).toBe(true));
}

const showMode = (mode: string, section?: string) => emitWith(SET_RIGHT_MODE, { mode, section });
const showScripts = () => showMode("files", "scripts");
const chip = (repoPath: string) => document.querySelector<HTMLElement>(`[data-member="${repoPath}"]`);
const chipRow = () => document.querySelector<HTMLElement>('[role="group"][aria-label="Feature members"]');

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  listening.ready = false;
  park = null;
  scripts = {};
  present = new Set<string>();
  FEATURE_MEMBERS = [member(API_REPO, "api", API, 0), member(WEB_REPO, "web", WEB, 1)];
});

afterEach(() => {
  cleanup();
});

describe("the member chip row", () => {
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

    fireEvent.click(chip(WEB_REPO)!);

    await waitFor(() => expect(screen.getByText("web:dev")).toBeTruthy());
    expect(screen.queryByText("api:serve")).toBeNull();
  });

  it("marks the member the pane is about", async () => {
    await mountEditor();
    showMode("files");
    await waitFor(() => expect(chip(API_REPO)).toBeTruthy());
    expect(chip(API_REPO)!.getAttribute("aria-pressed")).toBe("true");
    expect(chip(WEB_REPO)!.getAttribute("aria-pressed")).toBe("false");
  });

  it("wears a broken member's state and refuses to switch to it", async () => {
    FEATURE_MEMBERS = [member(API_REPO, "api", API, 0), member(WEB_REPO, "web", null, 1)];
    await mountEditor();
    // The right panel's row: the Files row lets a broken member be picked, to
    // show its repair (featureRoot.test.tsx).
    showMode("pulls");
    await waitFor(() => expect(chip(WEB_REPO)).toBeTruthy());
    const broken = chip(WEB_REPO) as HTMLButtonElement;
    expect(broken.disabled).toBe(true);
    expect(broken.getAttribute("aria-label")).toBe("web: Worktree missing");
  });

  it("is absent with only one member, which is not a choice", async () => {
    FEATURE_MEMBERS = [member(API_REPO, "api", API, 0)];
    await mountEditor();
    showMode("files");
    await waitFor(() => expect(screen.getByLabelText("Filter files")).toBeTruthy());
    expect(chipRow()).toBeNull();
  });
});

describe("the chip row past its cap", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => member(`/w/r${i}`, `r${i}`, `/w/r${i}/auth`, i));

  it("caps the row and puts the rest behind +N", async () => {
    FEATURE_MEMBERS = many(8);
    await mountEditor("/w/r0/auth");
    showMode("files");
    await waitFor(() => expect(chipRow()).toBeTruthy());
    expect(chipRow()!.querySelectorAll("[data-member]")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "4 more members" })).toBeTruthy();
  });

  it("never hides the member the pane is about", async () => {
    // The row's whole job is to say which member is in front. Dropping *that*
    // one for being eighth is the one thing it must not do.
    FEATURE_MEMBERS = many(8);
    await mountEditor("/w/r7/auth");
    showMode("files");
    await waitFor(() => expect(chip("/w/r7")).toBeTruthy());
    expect(chip("/w/r7")!.getAttribute("aria-pressed")).toBe("true");
    expect(chipRow()!.querySelectorAll("[data-member]")).toHaveLength(4);
    // It took the last slot rather than growing the row.
    expect(chip("/w/r3")).toBeNull();
  });

  it("switches to a hidden member from the +N menu", async () => {
    FEATURE_MEMBERS = many(8);
    scripts = { "/w/r0/auth": { first: "x" }, "/w/r7/auth": { last: "y" } };
    await mountEditor("/w/r0/auth");
    showScripts();
    await waitFor(() => expect(screen.getByText("first")).toBeTruthy());

    pointerClick(screen.getByRole("button", { name: "4 more members" }));
    await screen.findByRole("menu");
    pointerClick(screen.getByRole("menuitem", { name: "r7" }));

    await waitFor(() => expect(screen.getByText("last")).toBeTruthy());
  });
});
