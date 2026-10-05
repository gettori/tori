import type { Meta, StoryObj } from "storybook-solidjs-vite";
import Omnibox from "./Omnibox";
import type { Selection } from "../../panels/LeftSidebar/LeftSidebar";
import { clearEditorState, publishEditorState } from "../../utils/editorState";
import { clearSymbols, normalizeDocumentSymbols, publishSymbols } from "../../utils/symbols";
import { note, saveFrecency } from "../../utils/frecency";

// The command palette, one story per mode, since a mode is the whole shape of
// what is on screen rather than a variant of it.
//
// The workshop has no Tauri host behind it, so `list_project_files` answers
// nothing and the box shows what it can reach without a backend: the jump list
// and the frecency store (both browser storage), the command registry (a static
// table) and the mode list. That is enough to judge every row shape it renders,
// which is what these are for.

const REPO = "/Users/you/Projects/tori";

const selection: Selection = {
  spaceName: "personal",
  projectName: "tori",
  projectPath: REPO,
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
  profile: null,
};

const SYMBOLS = normalizeDocumentSymbols(
  [
    {
      name: "Omnibox",
      kind: 12,
      range: { start: { line: 159, character: 0 }, end: { line: 704, character: 1 } },
      selectionRange: { start: { line: 159, character: 24 }, end: { line: 159, character: 31 } },
      children: [
        {
          name: "fileRows",
          kind: 6,
          range: { start: { line: 326, character: 2 }, end: { line: 360, character: 3 } },
          selectionRange: { start: { line: 326, character: 8 }, end: { line: 326, character: 16 } },
        },
      ],
    },
    {
      name: "unmetReason",
      kind: 12,
      range: { start: { line: 92, character: 0 }, end: { line: 109, character: 1 } },
      selectionRange: { start: { line: 92, character: 9 }, end: { line: 92, character: 20 } },
    },
  ],
  `${REPO}/src/components/Omnibox/Omnibox.tsx`,
);

/** Every story starts from the same known state rather than from whatever the
 *  one before it left in module scope and browser storage. */
function seed(options: { file?: boolean; recents?: boolean; symbols?: boolean } = {}) {
  clearSymbols();
  clearEditorState();
  localStorage.clear();

  if (options.recents) {
    const now = Date.now();
    let store = {};
    for (const [i, rel] of ["src/App.tsx", "src/utils/fuzzy.ts", "src/theme/roles.ts"].entries()) {
      store = note(store, REPO, `${REPO}/${rel}`, "edit", now - (3 - i) * 60_000);
    }
    saveFrecency(store);
  }

  const active = `${REPO}/src/components/Omnibox/Omnibox.tsx`;
  if (options.file || options.symbols) {
    publishEditorState({
      activePath: active,
      dirty: true,
      tabCount: 3,
      projectRoot: REPO,
      recentJumps: options.recents
        ? [{ path: `${REPO}/src/components/Dialog/Dialog.tsx`, line: 37 }, { path: `${REPO}/src/lib/combobox.ts` }]
        : [],
    });
  }
  if (options.symbols) publishSymbols(active, SYMBOLS);
}

const meta = {
  title: "Components/Omnibox",
  component: Omnibox,
  parameters: { layout: "fullscreen" },
  args: {
    selected: selection,
    onOpenSettings: () => {},
    onClose: () => {},
  },
} satisfies Meta<typeof Omnibox>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The empty box, which is the one the grouping is for: where you have just
 *  been, then the files you work in, then the rest of the project under its own
 *  heading. Three blocks, so it is also the case that proves more than one
 *  heading survives a re-render. */
export const Files: Story = {
  render: (args) => {
    seed({ file: true, recents: true });
    return <Omnibox {...args} prefix="" />;
  },
};

/** The registry, with the two row shapes only this mode has: key chips for a
 *  command that also carries a binding, and a refusal reason for one whose
 *  requirement is unmet. Nothing is open here, so several are refused. */
export const Commands: Story = {
  render: (args) => {
    seed();
    return <Omnibox {...args} prefix=">" />;
  },
};

/** `?`, the mode whose results are the modes. Every row is a signpost: picking
 *  one retypes the box and leaves it open. */
export const Prefixes: Story = {
  render: (args) => {
    seed();
    return <Omnibox {...args} prefix="?" />;
  },
};

/** `@`, the open file's symbols in document order, each with its kind glyph. */
export const Symbols: Story = {
  render: (args) => {
    seed({ symbols: true, file: true });
    return <Omnibox {...args} prefix="@" />;
  },
};

/** Nothing to show, which every mode words for itself. With no file open there
 *  is nothing to go to a line in, and the list is withdrawn rather than
 *  emptied. */
export const Empty: Story = {
  render: (args) => {
    seed();
    return <Omnibox {...args} prefix=":" />;
  },
};
