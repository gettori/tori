import { expect, it, vi } from "vite-plus/test";
import { fireEvent, render, screen, waitFor } from "../../test/harness";
import { renderCost, renderDrift } from "../../test/perfCounters";

vi.mock("solid-js", async (original) => {
  const { countingSolid } = await import("../../test/perfCounters");
  return countingSolid(await original<typeof import("solid-js")>());
});

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";
const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  "@@ -10,3 +10,3 @@",
  " ten",
  "-eleven",
  "+ELEVEN",
  " twelve",
  "",
].join("\n");
const GAP = ["four", "five", "six", "seven", "eight", "nine"];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    switch (cmd) {
      case "git_diff_text":
        return Promise.resolve(DIFF);
      case "git_file_slice":
        return Promise.resolve(GAP);
      case "git_status":
        return Promise.resolve([{ status: " M", path: "src/a.ts", staged: false, unstaged: true }]);
      case "list_branches":
        return Promise.resolve([{ name: "main", current: true }]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: true });
      case "file_exists":
        return Promise.resolve(false);
      case "fs_read_dir":
        return Promise.resolve([]);
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => {
      code.listening = true;
      return Promise.resolve(() => {});
    },
  }),
}));
vi.mock("./syntaxLines", () => ({ languageForPath: async () => null, tokenLines: () => [] }));
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve(), stopEvictedLspRoots: () => Promise.resolve() }));

const code = vi.hoisted(() => ({
  listening: false,
  props: null as { activePath: string | null } | null,
}));
vi.mock("./CodeEditor", () => ({
  default: (props: { activePath: string | null }) => {
    code.props = props;
    return null;
  },
}));

const { default: Editor } = await import("./Editor");
const { default: DiffView } = await import("./DiffView");
const { emitWith, OPEN_IN_EDITOR } = await import("../../utils/events");

const selection = {
  spaceName: "space",
  projectName: "proj",
  projectPath: "/space/proj",
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
};

async function open(path: string) {
  emitWith(OPEN_IN_EDITOR, { path });
  await waitFor(() => expect(code.props?.activePath).toBe(path));
}

it("holds the render budget for one tab switch", async () => {
  localStorage.clear();
  const { container } = render(() => <Editor selected={selection as never} />);
  await waitFor(() => expect(code.listening).toBe(true));
  await open(`${REPO}/a.ts`);
  await open(`${REPO}/b.ts`);

  const cost = await renderCost(container, () => open(`${REPO}/a.ts`));

  expect(cost.memos + cost.effects).toBeGreaterThan(0);
  expect(renderDrift("editor.tab_switch", cost), JSON.stringify(cost)).toEqual([]);
});

it("holds the render budget for opening one collapsed gap", async () => {
  localStorage.clear();
  const { container } = render(() => <DiffView workspace="/proj" arg="unstaged:src/a.ts" selected={null} />);
  const gap = await screen.findByText(/6 unchanged lines/);

  const cost = await renderCost(container, async () => {
    fireEvent.click(gap);
    await screen.findByText(/^\s*four$/);
  });

  expect(cost.mutations).toBeGreaterThan(0);
  expect(renderDrift("editor.gap_open", cost), JSON.stringify(cost)).toEqual([]);
});
