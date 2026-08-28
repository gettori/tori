import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { mockIPC } from "@tauri-apps/api/mocks";
import FileTree, { clearListingCache, type TreeRoot } from "./FileTree";
import { memberState } from "../../../utils/features";
import { spaceHue } from "../../../utils/spaceTint";

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

// The tints come from the same helper the sidebar's chips use, so a swatch here
// is the swatch a member's Space would actually paint.
const MEMBERS: TreeRoot[] = [
  { path: API, repoPath: "/repos/api", label: "Payments API", tint: spaceHue("backend", "Indigo") },
  { path: WEB, repoPath: "/repos/web", label: "Web App", tint: spaceHue("frontend", "Emerald") },
  {
    // No worktree, so the section path is the repo itself, exactly as
    // `tintedMember` mints it.
    path: DOCS,
    repoPath: DOCS,
    label: "Docs Site",
    tint: spaceHue("docs", "Amber"),
    state: memberState({ kind: "worktree-missing" }),
  },
];

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

/** A Feature's three members, the last one with no worktree on disk: it keeps
 *  its header and offers the repair instead of pretending to be an empty repo. */
export const FeatureMembers: Story = {
  args: { roots: MEMBERS, onRepair: (path: string) => console.log("repair", path) },
};

/** Every member usable, which is the ordinary case. */
export const AllPresent: Story = {
  args: { roots: MEMBERS.slice(0, 2) },
};

/** One root renders headerless, exactly as a branch unit always has: no chip,
 *  no section, the create actions back in the toolbar. */
export const SingleRoot: Story = {
  args: { root: API },
};
