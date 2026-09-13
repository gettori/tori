import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { mockIPC } from "@tauri-apps/api/mocks";
import FileTree, { clearListingCache } from "./FileTree";

const API = "/feat/api";
const WEB = "/feat/web";
const DOCS = "/feat/docs";

const dir = (path: string, name: string) => ({
  name,
  path: `${path}/${name}`,
  is_dir: true,
  ignored: false,
  label: name,
});
const file = (path: string, name: string) => ({
  name,
  path: `${path}/${name}`,
  is_dir: false,
  ignored: false,
  label: name,
});

const DIRS: Record<string, unknown[]> = {
  [API]: [dir(API, "src"), dir(API, "migrations"), file(API, "Cargo.toml")],
  [`${API}/src`]: [file(`${API}/src`, "main.rs"), file(`${API}/src`, "routes.rs")],
  [`${API}/migrations`]: [file(`${API}/migrations`, "0001_init.sql")],
  [WEB]: [dir(WEB, "src"), file(WEB, "package.json")],
  [`${WEB}/src`]: [file(`${WEB}/src`, "App.tsx"), file(`${WEB}/src`, "main.tsx")],
  [DOCS]: [file(DOCS, "README.md")],
};

const FILES: Record<string, string[]> = {
  [API]: ["src/main.rs", "src/routes.rs", "migrations/0001_init.sql"],
  [WEB]: ["src/App.tsx", "src/main.tsx", "package.json"],
  [DOCS]: ["README.md"],
};

/** The workshop runs in a plain browser, so every command the tree sends has to
 *  be answered here or the panel paints empty. */
function stubHost() {
  clearListingCache();
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (cmd === "fs_read_dir_compact") return DIRS[a.path as string] ?? [];
    if (cmd === "list_project_files") return FILES[a.projectPath as string] ?? [];
    if (cmd === "get_workspace_settings") return { editor: {} };
    return null;
  });
}

const meta = {
  title: "Editor/FileTree",
  component: FileTree,
  args: {
    root: null,
    editable: true,
    noun: "member folder",
    askText: async () => "untitled.txt",
    askConfirm: async () => true,
  },
  decorators: [
    (Story) => {
      stubHost();
      return (
        <div style={{ display: "flex", width: "320px", height: "460px" }}>
          <Story />
        </div>
      );
    },
  ],
} satisfies Meta<typeof FileTree>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The Files tab's tree for one Feature member: the row menus name the member
 *  and offer Find in Folder and file history. */
export const FeatureMember: Story = {
  args: { root: WEB, member: "Web App", repoPath: "/repos/web" },
};

/** One root with the tree's own toolbar, as the Shared tab draws it. */
export const SingleRoot: Story = {
  args: { root: API },
};

/** Read-only: no create, rename or delete. */
export const ReadOnly: Story = {
  args: { root: DOCS, editable: false },
};
