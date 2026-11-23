import { expect, it, vi } from "vite-plus/test";
import { fireEvent, render, screen } from "../../../test/harness";
import { renderCost, renderDrift } from "../../../test/perfCounters";

vi.mock("solid-js", async (original) => {
  const { countingSolid } = await import("../../../test/perfCounters");
  return countingSolid(await original<typeof import("solid-js")>());
});

type Entry = { name: string; path: string; is_dir: boolean; ignored: boolean };
const ROOT = "/proj";
const entry = (dir: string, name: string, is_dir = false): Entry => ({
  name,
  path: `${dir}/${name}`,
  is_dir,
  ignored: false,
});

const bridge = vi.hoisted(() => ({
  dirs: {} as Record<string, unknown[]>,
  listeners: {} as Record<string, ((e: { payload: unknown }) => void)[]>,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    (bridge.listeners[name] ??= []).push(cb);
    return Promise.resolve(() => {});
  },
}));
vi.mock("@tauri-apps/api/core", async () => {
  const { compactRows } = await import("../../../test/compactDirs");
  return {
    invoke: (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "fs_read_dir_compact") {
        return Promise.resolve(
          compactRows(
            bridge.dirs as Record<string, Entry[]>,
            args as { path: string; compact: boolean; hidden: string[] },
          ),
        );
      }
      if (cmd === "fs_read_dir") return Promise.resolve(bridge.dirs[args.path as string] ?? []);
      if (cmd === "get_workspace_settings") return Promise.resolve({ editor: {} });
      return Promise.resolve(null);
    },
  };
});

const { default: FileTree } = await import("./FileTree");

it("holds the render budget for one fs change in an expanded directory", async () => {
  localStorage.clear();
  bridge.dirs[ROOT] = [entry(ROOT, "src", true), entry(ROOT, "README.md")];
  bridge.dirs[`${ROOT}/src`] = [entry(`${ROOT}/src`, "a.ts"), entry(`${ROOT}/src`, "b.ts")];
  const { container } = render(() => (
    <FileTree
      root={ROOT}
      editable
      noun="project folder"
      askText={() => Promise.resolve(null)}
      askConfirm={() => Promise.resolve(false)}
    />
  ));
  fireEvent.click(await screen.findByText("src"));
  await screen.findByText("a.ts");

  const cost = await renderCost(container, async () => {
    bridge.dirs[`${ROOT}/src`] = [...bridge.dirs[`${ROOT}/src`], entry(`${ROOT}/src`, "c.ts")];
    for (const listener of bridge.listeners["fs://changed"] ?? []) {
      listener({ payload: { root: ROOT, paths: [`${ROOT}/src/c.ts`] } });
    }
    await screen.findByText("c.ts", {}, { timeout: 2000 });
  });

  expect(cost.mutations).toBeGreaterThan(0);
  expect(renderDrift("file_tree.fs_changed", cost), JSON.stringify(cost)).toEqual([]);
});
