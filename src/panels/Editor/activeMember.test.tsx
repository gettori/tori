// The modes that answer for the member `activeRoot` points at (#160 phase 3):
// Pull requests, Tasks and Docs.
//
// Docs was not merely pointed at the wrong member inside a Feature, it was
// permanently hidden: it built its folder from a `spaceName` of "" and the
// Feature's own name. It resolves per member now, and the chip row under the
// tab strip is what moves that member.
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

const DOCS_ROOT = "/docs";

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
      case "get_docs_root":
        return Promise.resolve(DOCS_ROOT);
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

let setSel: ((s: unknown) => void) | null = null;

/** Mount with the chip row wired to the same handler App gives it, so clicking
 *  a chip really moves the selection. */
async function mountEditor(initial = API) {
  for (const bump of featureHandlers) bump();
  const [sel, set] = createSignal<unknown>(featureSel(initial));
  setSel = set;
  render(() => (
    <Editor
      selected={sel() as never}
      onActiveRoot={(root) => set(featureSel(root))}
    />
  ));
  await waitFor(() => expect(listening.ready).toBe(true));
}

const showMode = (mode: string) => emitWith(SET_RIGHT_MODE, { mode });
const chip = (repoPath: string) => document.querySelector<HTMLElement>(`[data-member="${repoPath}"]`);
const chipRow = () => document.querySelector<HTMLElement>('[role="group"][aria-label="Feature members"]');
const tabFor = (name: string) => screen.queryByRole("tab", { name });

beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  listening.ready = false;
  park = null;
  scripts = {};
  present = new Set([`${DOCS_ROOT}/work/api`, `${DOCS_ROOT}/work/web`]);
  FEATURE_MEMBERS = [member(API_REPO, "api", API, 0), member(WEB_REPO, "web", WEB, 1)];
});

afterEach(() => {
  cleanup();
  setSel = null;
});

describe("the member chip row", () => {
  it("is drawn for the modes that answer for one member, and no others", async () => {
    await mountEditor();
    for (const mode of ["pulls", "tasks", "docs"]) {
      showMode(mode);
      await waitFor(() => expect(chipRow()).toBeTruthy());
    }
    // Files answers for the whole Feature: it draws a section per member and
    // has no single member to switch.
    showMode("files");
    await waitFor(() => expect(chipRow()).toBeNull());
  });

  it("moves the active member, and the pane below reloads for it", async () => {
    scripts = { [API]: { "api:serve": "node ." }, [WEB]: { "web:dev": "vite" } };
    await mountEditor();
    showMode("tasks");
    await waitFor(() => expect(screen.getByText("api:serve")).toBeTruthy());

    fireEvent.click(chip(WEB_REPO)!);

    await waitFor(() => expect(screen.getByText("web:dev")).toBeTruthy());
    expect(screen.queryByText("api:serve")).toBeNull();
  });

  it("marks the member the pane is about", async () => {
    await mountEditor();
    showMode("tasks");
    await waitFor(() => expect(chip(API_REPO)).toBeTruthy());
    expect(chip(API_REPO)!.getAttribute("aria-pressed")).toBe("true");
    expect(chip(WEB_REPO)!.getAttribute("aria-pressed")).toBe("false");
  });

  it("wears a broken member's state and refuses to switch to it", async () => {
    FEATURE_MEMBERS = [member(API_REPO, "api", API, 0), member(WEB_REPO, "web", null, 1)];
    await mountEditor();
    showMode("tasks");
    await waitFor(() => expect(chip(WEB_REPO)).toBeTruthy());
    const broken = chip(WEB_REPO) as HTMLButtonElement;
    expect(broken.disabled).toBe(true);
    expect(broken.getAttribute("aria-label")).toBe("web: Worktree missing");
  });

  it("is absent with only one member, which is not a choice", async () => {
    FEATURE_MEMBERS = [member(API_REPO, "api", API, 0)];
    await mountEditor();
    showMode("tasks");
    await waitFor(() => expect(tabFor("Tasks")).toBeTruthy());
    expect(chipRow()).toBeNull();
  });
});

describe("the chip row past its cap", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => member(`/w/r${i}`, `r${i}`, `/w/r${i}/auth`, i));

  it("caps the row and puts the rest behind +N", async () => {
    FEATURE_MEMBERS = many(8);
    await mountEditor("/w/r0/auth");
    showMode("tasks");
    await waitFor(() => expect(chipRow()).toBeTruthy());
    expect(chipRow()!.querySelectorAll("[data-member]")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "2 more members" })).toBeTruthy();
  });

  it("never hides the member the pane is about", async () => {
    // The row's whole job is to say which member is in front. Dropping *that*
    // one for being eighth is the one thing it must not do.
    FEATURE_MEMBERS = many(8);
    await mountEditor("/w/r7/auth");
    showMode("tasks");
    await waitFor(() => expect(chip("/w/r7")).toBeTruthy());
    expect(chip("/w/r7")!.getAttribute("aria-pressed")).toBe("true");
    expect(chipRow()!.querySelectorAll("[data-member]")).toHaveLength(6);
    // It took the last slot rather than growing the row.
    expect(chip("/w/r5")).toBeNull();
  });

  it("switches to a hidden member from the +N menu", async () => {
    FEATURE_MEMBERS = many(8);
    scripts = { "/w/r0/auth": { first: "x" }, "/w/r7/auth": { last: "y" } };
    await mountEditor("/w/r0/auth");
    showMode("tasks");
    await waitFor(() => expect(screen.getByText("first")).toBeTruthy());

    pointerClick(screen.getByRole("button", { name: "2 more members" }));
    await screen.findByRole("menu");
    pointerClick(screen.getByRole("menuitem", { name: "r7" }));

    await waitFor(() => expect(screen.getByText("last")).toBeTruthy());
  });
});

describe("the Docs tab inside a Feature", () => {
  it("resolves the folder from the active member's space and project", async () => {
    await mountEditor(API);
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "file_exists" && c.args.path === `${DOCS_ROOT}/work/api`)).toBe(
        true,
      ),
    );
    // Not `<docsRoot>//Auth`: the selection's own space is "" and its project
    // name is the Feature's, which name no folder on disk.
    expect(calls.some((c) => c.cmd === "file_exists" && String(c.args.path).includes("Auth"))).toBe(false);
    await waitFor(() => expect(tabFor("Docs")).toBeTruthy());
  });

  it("lets the newer probe win when a slower one answers after it", async () => {
    // Two moves in quick succession leave two `file_exists` in flight. Without
    // the generation guard the slower answer overwrites the newer one, and Docs
    // shows the member you already left.
    park = { path: `${DOCS_ROOT}/work/api`, release: () => {} };
    present = new Set([`${DOCS_ROOT}/work/web`]);
    await mountEditor(API);
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "file_exists" && c.args.path === `${DOCS_ROOT}/work/api`)).toBe(
        true,
      ),
    );

    setSel!(featureSel(WEB));
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "file_exists" && c.args.path === `${DOCS_ROOT}/work/web`)).toBe(
        true,
      ),
    );
    await waitFor(() => expect(tabFor("Docs")).toBeTruthy());

    // The stale probe answers last, and says the folder does not exist.
    park.release();
    await Promise.resolve();
    await Promise.resolve();

    // Still the web member's folder: the older answer was dropped.
    expect(tabFor("Docs")).toBeTruthy();
  });
});
