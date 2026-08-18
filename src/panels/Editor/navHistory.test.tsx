import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import PaneView from "../../tabs/PaneView";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent, within } from "@solidjs/testing-library";
import { pointerClick } from "../../test/menus";

// Back and Forward, from the pane's side.
//
// `jumpList.ts` owns the rule and is tested on its own; `cursorJump.ts` owns
// what the caret reports. This is the part neither can see: that the recording
// site is the OPEN_IN_EDITOR chokepoint and *only* that, that going back does
// not record the trip, and that the arrows read the list they claim to.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const REPO = "/space/proj/main";
const OTHER = "/space/proj/feature";

// Folders the backend would list. Empty unless a test fills one in, so the tree
// stays as bare as it always was and only the breadcrumb picker sees anything.
const dirs: Record<string, { name: string; path: string; is_dir: boolean; ignored: boolean }[]> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "git_status":
        return Promise.resolve([]);
      case "list_branches":
        return Promise.resolve([{ name: "main", current: true }]);
      case "git_ahead_behind":
        return Promise.resolve({ ahead: 0, behind: 0, has_upstream: true });
      // No docs root, nothing restorable, an empty tree: every file this suite
      // navigates through is one it opened itself.
      case "get_docs_root":
        return Promise.reject("no docs root");
      case "file_exists":
        return Promise.resolve(false);
      case "fs_read_dir":
        return Promise.resolve(dirs[args.path as string] ?? []);
      default:
        return Promise.resolve(null);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
const listening = { ready: false };
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => {
      listening.ready = true;
      return Promise.resolve(() => {});
    },
  }),
}));

// The real editor is all of CodeMirror and owns none of this. The stand-in is
// how the suite reads what the pane decided (which file is shown, which line it
// was told to jump to) and how it plays back a caret jump.
type CodeProps = {
  activePath: string | null;
  goto: { path: string; line: number } | null;
  onCursorJump?: (path: string, line: number) => void;
};
let code: CodeProps | null = null;
vi.mock("./CodeEditor", () => ({
  default: (p: CodeProps) => {
    code = p;
    return null;
  },
}));
vi.mock("./lspClient", () => ({ stopAllLsp: () => Promise.resolve() }));

const { default: Editor } = await import("./Editor");
const { emitWith, OPEN_IN_EDITOR, EDITOR_NAV_BACK, EDITOR_NAV_FORWARD, FILE_RENAMED, PURGE_UNDER_PATH } =
  await import("../../utils/events");

const selectionFor = (folderPath: string) => ({
  spaceName: "space",
  projectName: "proj",
  projectPath: "/space/proj",
  folderPath,
  branch: "main",
  projectKind: "plain",
});

let mounted: ReturnType<typeof render> | null = null;
let setSelected: ((s: unknown) => void) | null = null;

async function mountEditor(folderPath = REPO) {
  const [selected, setter] = createSignal<unknown>(selectionFor(folderPath));
  setSelected = setter;
  mounted = render(() => (
      <>
        <Editor selected={selected() as never} />
        <PaneView pinKind="file" />
      </>
    ));
  await waitFor(() => expect(listening.ready).toBe(true));
}

const EMPTY_PANE = /Open a file from the tree/;

/** Arrive somewhere, exactly as the named surface does. */
async function arrive(payload: { path: string; line?: number }) {
  emitWith(OPEN_IN_EDITOR, payload);
  await waitFor(() => expect(code?.activePath).toBe(payload.path));
}

const backBtn = () => screen.getByLabelText(/^Go back to where you were/) as HTMLButtonElement;
const fwdBtn = () => screen.getByLabelText(/^Go forward again/) as HTMLButtonElement;

async function goBack(to: string) {
  fireEvent.click(backBtn());
  await waitFor(() => expect(code?.activePath).toBe(to));
}

async function goForward(to: string) {
  fireEvent.click(fwdBtn());
  await waitFor(() => expect(code?.activePath).toBe(to));
}

const inTrail = () => within(document.querySelector("nav[aria-label='Breadcrumbs']") as HTMLElement);

beforeEach(() => {
  code = null;
  listening.ready = false;
  for (const key of Object.keys(dirs)) delete dirs[key];
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  setSelected = null;
});

describe("recording where you have been", () => {
  // The four surfaces the ticket names all reach the editor through one event,
  // which is the point: one recording site is what keeps each of them worth
  // exactly one entry. Four arrivals must therefore be three steps back and no
  // more - a second recording site anywhere would leave the arrow still live.
  it("counts one entry per arrival, whichever surface asked for it", async () => {
    await mountEditor();
    await arrive({ path: `${REPO}/tree.ts` }); // a file-tree click
    await arrive({ path: `${REPO}/def.ts` }); // go-to-definition, via lspClient
    await arrive({ path: `${REPO}/hit.ts`, line: 120 }); // a search hit
    await arrive({ path: `${REPO}/pick.ts` }); // a quick-open pick

    await goBack(`${REPO}/hit.ts`);
    // The line came back with it, not just the file.
    expect(code?.goto).toMatchObject({ path: `${REPO}/hit.ts`, line: 120 });
    await goBack(`${REPO}/def.ts`);
    await goBack(`${REPO}/tree.ts`);
    expect(backBtn().disabled).toBe(true);
  });

  it("records a sibling picked from the breadcrumb trail", async () => {
    // The trail's own test proves the pick leaves through OPEN_IN_EDITOR. This
    // is the other half: that arriving that way is an arrival like any other,
    // so Back can take you off the file the picker put you on.
    dirs[`${REPO}/src`] = [
      { name: "other.ts", path: `${REPO}/src/other.ts`, is_dir: false, ignored: false },
      { name: "thing.ts", path: `${REPO}/src/thing.ts`, is_dir: false, ignored: false },
    ];
    await mountEditor();
    await arrive({ path: `${REPO}/src/thing.ts` });
    expect(backBtn().disabled).toBe(true);

    pointerClick(inTrail().getByText("thing.ts"));
    pointerClick(await screen.findByRole("menuitem", { name: "other.ts" }));
    await waitFor(() => expect(code?.activePath).toBe(`${REPO}/src/other.ts`));
    expect(backBtn().disabled).toBe(false);
    await goBack(`${REPO}/src/thing.ts`);
  });

  it("records a TODO opened from the explorer, at its line", async () => {
    // The panel's own test proves the row leaves through OPEN_IN_EDITOR. This
    // is the other half: a TODO is a place, so Back takes you off it and the
    // line it carried is what you came back from.
    await mountEditor();
    await arrive({ path: `${REPO}/a.ts` });
    await arrive({ path: `${REPO}/src/leaky.ts`, line: 42 });

    expect(code?.goto).toMatchObject({ path: `${REPO}/src/leaky.ts`, line: 42 });
    expect(backBtn().disabled).toBe(false);
    await goBack(`${REPO}/a.ts`);
  });

  it("greys out both arrows with nothing open, and forward until you have gone back", async () => {
    await mountEditor();
    await arrive({ path: `${REPO}/a.ts` });
    expect(backBtn().disabled).toBe(true);
    expect(fwdBtn().disabled).toBe(true);

    await arrive({ path: `${REPO}/b.ts` });
    expect(backBtn().disabled).toBe(false);
    expect(fwdBtn().disabled).toBe(true);
  });

  it("does not record the trip taken by going back", async () => {
    await mountEditor();
    await arrive({ path: `${REPO}/a.ts` });
    await arrive({ path: `${REPO}/b.ts` });

    await goBack(`${REPO}/a.ts`);
    await goForward(`${REPO}/b.ts`);
    // Two entries still, not four: a Back that recorded its own arrival would
    // have buried the forward leg under it.
    expect(fwdBtn().disabled).toBe(true);
    await goBack(`${REPO}/a.ts`);
    expect(backBtn().disabled).toBe(true);
  });

  it("drops the forward leg once you go somewhere new", async () => {
    await mountEditor();
    await arrive({ path: `${REPO}/a.ts` });
    await arrive({ path: `${REPO}/b.ts` });
    await goBack(`${REPO}/a.ts`);
    expect(fwdBtn().disabled).toBe(false);

    await arrive({ path: `${REPO}/c.ts` });

    expect(fwdBtn().disabled).toBe(true);
    await goBack(`${REPO}/a.ts`);
    expect(backBtn().disabled).toBe(true);
  });

  it("takes a caret jump as a place, refining the file it is already standing on", async () => {
    await mountEditor();
    await arrive({ path: `${REPO}/a.ts` });

    code!.onCursorJump!(`${REPO}/a.ts`, 300);
    // Still one place: opening the file and landing inside it are one
    // destination, and two entries would make the first Back press look broken.
    await waitFor(() => expect(backBtn().disabled).toBe(true));

    await arrive({ path: `${REPO}/b.ts` });
    await goBack(`${REPO}/a.ts`);
    expect(code?.goto).toMatchObject({ path: `${REPO}/a.ts`, line: 300 });
  });

  it("runs on the palette's commands as well as the arrows", async () => {
    await mountEditor();
    await arrive({ path: `${REPO}/a.ts` });
    await arrive({ path: `${REPO}/b.ts` });

    emitWith(EDITOR_NAV_BACK, null);
    await waitFor(() => expect(code?.activePath).toBe(`${REPO}/a.ts`));
    emitWith(EDITOR_NAV_FORWARD, null);
    await waitFor(() => expect(code?.activePath).toBe(`${REPO}/b.ts`));
  });

  it("never records a synthetic view, which is a thing opened rather than a place", async () => {
    await mountEditor();
    await arrive({ path: `${REPO}/a.ts` });
    emitWith(OPEN_IN_EDITOR, { path: `sway://commit/abc/${REPO}` });
    await waitFor(() => expect(screen.queryByText(EMPTY_PANE)).toBeNull());

    // The commit tab is open, but Back has nowhere to go: the only place
    // recorded is the one file.
    expect(backBtn().disabled).toBe(true);
  });

  // The list is keyed by absolute path, exactly like the tab strip and the
  // dirty flags, so Phase 1's tree edits have to reach it too. An arrow onto a
  // renamed or trashed file opens a tab on a path that is not there any more.
  it("follows a rename to the new path", async () => {
    await mountEditor();
    await arrive({ path: `${REPO}/old.ts`, line: 12 });
    await arrive({ path: `${REPO}/other.ts` });

    emitWith(FILE_RENAMED, { from: `${REPO}/old.ts`, to: `${REPO}/new.ts` });

    await goBack(`${REPO}/new.ts`);
    expect(code?.goto).toMatchObject({ path: `${REPO}/new.ts`, line: 12 });
  });

  it("forgets a place that was trashed, even with no tab left holding it", async () => {
    await mountEditor();
    await arrive({ path: `${REPO}/doomed/x.ts` });
    await arrive({ path: `${REPO}/keep.ts` });
    expect(backBtn().disabled).toBe(false);

    emitWith(PURGE_UNDER_PATH, { path: `${REPO}/doomed` });

    // The only other place is gone, so there is nowhere to go back to.
    await waitFor(() => expect(backBtn().disabled).toBe(true));
  });

  it("keeps each workspace's history to itself", async () => {
    await mountEditor();
    await arrive({ path: `${REPO}/a.ts` });
    await arrive({ path: `${REPO}/b.ts` });
    expect(backBtn().disabled).toBe(false);

    setSelected!(selectionFor(OTHER));
    // A branch-unit with nothing visited has nowhere to go back to, even though
    // the other one does.
    await waitFor(() => expect(backBtn().disabled).toBe(true));

    setSelected!(selectionFor(REPO));
    await waitFor(() => expect(backBtn().disabled).toBe(false));
  });
});
