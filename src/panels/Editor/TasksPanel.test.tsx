import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

// The panel through its real seams: the tasks come from the project's own files
// via `fs_read_dir`/`fs_read_file`, and a run leaves as `OPEN_TERMINAL` carrying
// a login-shell tab seeded with `init`. Neither is mocked away, because the
// shape of that tab is the whole ticket: the command line is delivered
// backend-once, so a remount re-subscribes rather than typing it again.

const REPO = "/proj";

/** `dir: null` stands for a folder the backend refuses to list. */
const bridge: { dir: string[] | null; files: Record<string, string> } = { dir: [], files: {} };

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "fs_read_dir") {
      return bridge.dir
        ? Promise.resolve(bridge.dir.map((name) => ({ name })))
        : Promise.reject(new Error("cannot list /proj"));
    }
    if (cmd === "fs_read_file") {
      const hit = bridge.files[args.path as string];
      return hit === undefined ? Promise.reject(new Error("ENOENT")) : Promise.resolve(hit);
    }
    if (cmd === "list_project_files") return Promise.resolve([]);
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));

import TasksPanel from "./TasksPanel";
import Omnibox from "../../components/Omnibox/Omnibox";
import { OPEN_TERMINAL, type OpenTerminal } from "../../utils/events";
import { lastRun, loadTaskRuns } from "../../utils/taskRecents";

/** A workspace defining one of each: a pnpm script, a Make target, a just recipe. */
function fixtureWorkspace() {
  bridge.dir = ["package.json", "pnpm-lock.yaml", "Makefile", "justfile", "src"];
  bridge.files = {
    "/proj/package.json": JSON.stringify({ scripts: { dev: "vite", build: "tsc" } }),
    "/proj/Makefile": "release:\n\tcargo build --release\n",
    "/proj/justfile": "fmt:\n    cargo fmt\n",
  };
}

function mount(root: string | null = REPO) {
  return render(() => <TasksPanel root={root} />);
}

/** Every OPEN_TERMINAL that goes out while `fn` runs. */
async function opened(fn: () => void): Promise<OpenTerminal[]> {
  const seen: OpenTerminal[] = [];
  const listener = (e: Event) => seen.push((e as CustomEvent<OpenTerminal>).detail);
  window.addEventListener(OPEN_TERMINAL, listener);
  try {
    fn();
    await Promise.resolve();
  } finally {
    window.removeEventListener(OPEN_TERMINAL, listener);
  }
  return seen;
}

beforeEach(() => {
  localStorage.clear();
  bridge.dir = [];
  bridge.files = {};
});

describe("what it lists", () => {
  it("shows what the project defines, in all three formats", async () => {
    fixtureWorkspace();
    mount();
    await waitFor(() => expect(screen.getByText("dev")).toBeTruthy());
    expect(screen.getByText("build")).toBeTruthy();
    expect(screen.getByText("release")).toBeTruthy();
    expect(screen.getByText("fmt")).toBeTruthy();
  });

  it("shows the line each one runs, with the project's own package manager", async () => {
    // `npm run dev` in a pnpm repo is not a preference somebody got wrong, it is
    // a command that installs the wrong tree.
    fixtureWorkspace();
    mount();
    await waitFor(() => expect(screen.getByText("pnpm run dev")).toBeTruthy());
    expect(screen.getByText("make release")).toBeTruthy();
    expect(screen.getByText("just fmt")).toBeTruthy();
  });

  it("says a project defines none rather than showing an empty list", async () => {
    bridge.dir = ["src", "README.md"];
    mount();
    await waitFor(() => expect(screen.getByText(/Sway reads npm scripts/)).toBeTruthy());
  });

  it("says a project could not be read rather than that it defines nothing", async () => {
    // Those are different facts, and only one of them is about the project.
    bridge.dir = null;
    mount();
    await waitFor(() => expect(screen.getByText(/cannot list/)).toBeTruthy());
    expect(screen.queryByText(/Sway reads npm scripts/)).toBeNull();
  });

  it("does not claim a project has none when there is no project", async () => {
    mount(null);
    await waitFor(() => expect(screen.getByText("Open a project to see its tasks.")).toBeTruthy());
    expect(screen.queryByText(/Sway reads npm scripts/)).toBeNull();
  });
});

describe("the palette and the panel", () => {
  it("show the same set for a fixture workspace", async () => {
    // One reader (`utils/tasks.ts`) behind both, checked rather than trusted: a
    // second reader is exactly how a project ends up with a task you can run
    // from one surface and not the other.
    fixtureWorkspace();
    const panel = mount();
    await waitFor(() => expect(screen.getByText("dev")).toBeTruthy());
    // Row layout is [icon, name, command], so the name is the second child.
    const inPanel = [...panel.container.querySelectorAll("button")].map(
      (b) => b.children[1]?.textContent ?? "",
    );

    const box = render(() => (
      <Omnibox
        prefix=">"
        selected={{ folderPath: REPO, projectName: "proj" } as never}
        onOpenSettings={() => {}}
        onClose={() => {}}
      />
    ));
    await waitFor(() => expect(screen.getAllByText(/^Run task: /).length).toBe(4));
    const inBox = screen.getAllByText(/^Run task: /).map((el) => el.textContent!.slice("Run task: ".length));
    box.unmount();

    expect(inBox).toEqual(["dev", "build", "release", "fmt"]);
    expect(inPanel).toEqual(inBox);
  });
});

describe("running one", () => {
  it("opens a login-shell tab carrying the command as init", async () => {
    // Never a `pty_write` after the spawn: `pty_spawn` delivers `init` once and
    // is idempotent, so remounting the tab re-subscribes to the live process
    // instead of typing the command a second time.
    fixtureWorkspace();
    mount();
    await waitFor(() => expect(screen.getByText("dev")).toBeTruthy());

    const tabs = await opened(() => fireEvent.click(screen.getByText("dev")));
    expect(tabs).toHaveLength(1);
    expect(tabs[0].kind).toBe("task");
    expect(tabs[0].init).toBe("pnpm run dev\n");
    expect(tabs[0].program).toBe("");
    expect(tabs[0].cwd).toBe(REPO);
    expect(tabs[0].title).toBe("dev");
  });

  it("gives a second run its own tab", async () => {
    // A shell takes exactly one `init`, so reusing the tab would either need the
    // write this ticket rules out or silently do nothing.
    fixtureWorkspace();
    mount();
    await waitFor(() => expect(screen.getByText("dev")).toBeTruthy());

    const first = await opened(() => fireEvent.click(screen.getByText("dev")));
    const second = await opened(() => fireEvent.click(screen.getAllByText("dev")[0]));
    expect(second[0].id).not.toBe(first[0].id);
    expect(second[0].title).toBe("dev (2)");
  });

  it("remembers it, so the rerun hotkey has something to repeat", async () => {
    // Written through to storage rather than held in the panel: the hotkey fires
    // while another right-hand mode is showing and this component is gone.
    fixtureWorkspace();
    mount();
    await waitFor(() => expect(screen.getByText("release")).toBeTruthy());

    await opened(() => fireEvent.click(screen.getByText("release")));
    expect(lastRun(loadTaskRuns(), REPO)?.name).toBe("release");
    await waitFor(() => expect(screen.getByText("Recent")).toBeTruthy());
  });

  it("runs nothing when there is no project to run it in", async () => {
    fixtureWorkspace();
    mount(null);
    await waitFor(() => expect(screen.getByText("Open a project to see its tasks.")).toBeTruthy());
    expect(screen.queryByText("dev")).toBeNull();
  });
});
