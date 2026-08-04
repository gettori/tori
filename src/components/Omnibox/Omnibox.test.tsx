import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";

// The one box, and its six modes. It carries what ⌘P and ⌘K each used to own, so
// most of what is asserted here was asserted of one of them before: the files,
// the actions, the two symbol modes. What is new is that they are one overlay
// reached by a prefix, that switching modes never closes it, and that the empty
// box leads with where you have just been.

const REPO = "/root/work/repo";

const bridge = vi.hoisted(() => ({ calls: [] as string[], files: [] as string[] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    bridge.calls.push(cmd);
    return cmd === "list_project_files" ? Promise.resolve(bridge.files) : Promise.resolve(null);
  },
}));

const { default: Omnibox } = await import("./Omnibox");
const { setLiveChat, dropLiveChat } = await import("../../utils/chatSessions");
const { publishEditorState, clearEditorState } = await import("../../utils/editorState");
const { refreshStatus } = await import("../../utils/gitActions");
const {
  publishSymbols,
  clearSymbols,
  normalizeDocumentSymbols,
  normalizeWorkspaceSymbols,
  setWorkspaceSymbolSearch,
} = await import("../../utils/symbols");
const { onWith, NEW_SESSION, SET_RIGHT_MODE, TOGGLE_TERMINAL, STOP_CHAT, EDITOR_SAVE, OPEN_IN_EDITOR } =
  await import("../../utils/events");
const { note, saveFrecency } = await import("../../utils/frecency");
type OpenInEditor = { path: string; line?: number; col?: number };

const PATH = `${REPO}/src/alpha.ts`;

const selection = {
  spaceName: "work",
  projectName: "repo",
  projectPath: REPO,
  folderPath: REPO,
  branch: "main",
  projectKind: "plain",
};

const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

const TREE = normalizeDocumentSymbols(
  [
    {
      name: "Thing",
      kind: 5,
      range: range(0, 0, 6, 1),
      selectionRange: range(0, 6, 0, 11),
      children: [{ name: "gogo", kind: 6, range: range(1, 2, 3, 3), selectionRange: range(1, 2, 1, 6) }],
    },
    { name: "helper", kind: 12, range: range(8, 0, 10, 1), selectionRange: range(8, 9, 8, 15) },
  ],
  PATH,
);

const toPath = (uri: string) => (uri.startsWith("file://") ? uri.slice("file://".length) : null);

// The box portals to <body>, which the shared `cleanup` does not reach.
let mounted: ReturnType<typeof render> | null = null;
const onOpenSettings = vi.fn();
const onClose = vi.fn();
let opened: OpenInEditor[] = [];
let searched: string[] = [];
let offOpen: (() => void) | undefined;
let offSearch: (() => void) | undefined;

/** Open the box on a prefix: `""` is what ⌘P sends, `">"` what ⌘K sends. */
function open(prefix = "") {
  mounted = render(() => (
    <Omnibox prefix={prefix} selected={selection} onOpenSettings={onOpenSettings} onClose={onClose} />
  ));
}

const input = () => screen.getByRole("textbox");
const typeInto = (value: string) => fireEvent.input(input(), { target: { value } });

/** Every row's label, in order. */
function rowLabels(): string[] {
  return [...document.querySelectorAll('[class*="itemLabel"]')].map((el) => el.textContent ?? "");
}

// Click the row named `label` and hand back what it put on the bus. A payload-
// less `emit()` carries `detail: null`, so `fired` (rather than the detail) is
// what says the event happened at all.
const FIRED = Symbol("fired");
function fire(label: string, event: string): unknown {
  let payload: unknown;
  const on = (e: Event) => (payload = (e as CustomEvent).detail ?? FIRED);
  window.addEventListener(event, on);
  fireEvent.click(screen.getByText(label));
  window.removeEventListener(event, on);
  return payload;
}

beforeEach(async () => {
  bridge.calls.length = 0;
  bridge.files = [];
  onOpenSettings.mockClear();
  onClose.mockClear();
  // Both are read from storage, which jsdom keeps between tests: a leftover
  // record would decide another test's order.
  localStorage.clear();
  clearSymbols();
  clearEditorState();
  opened = [];
  searched = [];
  offOpen = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => opened.push(d));
  await refreshStatus(null);
});

afterEach(() => {
  offOpen?.();
  offSearch?.();
  offSearch = undefined;
  mounted?.unmount();
  mounted = null;
  dropLiveChat("chat-1");
  clearSymbols();
  clearEditorState();
});

describe("the prefix router", () => {
  it("opens on files from ⌘P and on actions from ⌘K", () => {
    open("");
    expect(screen.getByText("Files")).toBeTruthy();
    mounted!.unmount();

    open(">");
    expect(screen.getByText("Commands")).toBeTruthy();
    expect(rowLabels()).toContain("Show or hide the sidebar");
  });

  // The whole reason for one box rather than two: a mode is a keystroke inside
  // it, so changing your mind costs neither an Escape nor a retyped query.
  it("switches mode in place, without closing", () => {
    open("");
    typeInto(">side");
    expect(screen.getByText("Commands")).toBeTruthy();
    expect(rowLabels()).toContain("Show or hide the sidebar");

    typeInto("side");
    expect(screen.getByText("Files")).toBeTruthy();

    expect(onClose).not.toHaveBeenCalled();
  });

  it("says which mode it is in", () => {
    open("");
    for (const [query, title] of [
      [">", "Commands"],
      ["@", "Symbols in this file"],
      ["#", "Symbols in the project"],
      [":", "Go to line"],
      ["?", "What the prefixes do"],
      ["", "Files"],
    ]) {
      typeInto(query);
      expect(screen.getByText(title), query).toBeTruthy();
    }
  });
});

describe("? - what the prefixes do", () => {
  it("lists every other mode", () => {
    open("?");
    expect(rowLabels()).toEqual([
      "(no prefix)  Files",
      ">  Commands",
      "@  Symbols in this file",
      "#  Symbols in the project",
      ":  Go to line",
    ]);
  });

  it("enters the mode it names rather than closing", () => {
    // A signpost, not a destination. Closing here would undo the reason the box
    // was opened, which was not knowing what to type.
    open("?");
    // Matched loosely: the label's double space is what separates the prefix
    // from its name on screen, and the DOM matcher collapses it.
    fireEvent.click(screen.getByText(/^>\s+Commands$/));

    expect(onClose).not.toHaveBeenCalled();
    expect((input() as HTMLInputElement).value).toBe(">");
    expect(rowLabels()).toContain("Show or hide the sidebar");
  });
});

describe("files", () => {
  beforeEach(() => {
    bridge.files = ["src/alpha.ts", "src/beta.ts"];
  });

  it("lists the project's files and filters them", async () => {
    open();
    await waitFor(() => expect(screen.getByText("src/alpha.ts")).toBeTruthy());
    typeInto("beta");
    expect(screen.queryByText("src/alpha.ts")).toBeNull();
    expect(screen.getByText("src/beta.ts")).toBeTruthy();
  });

  it("opens one relative to the project root", async () => {
    open();
    await waitFor(() => expect(screen.getByText("src/beta.ts")).toBeTruthy());
    expect(fire("src/beta.ts", OPEN_IN_EDITOR)).toEqual({ path: `${REPO}/src/beta.ts` });
  });

  // The empty box is the one the ranking is for: with nothing typed there is no
  // query to sort by, so the only useful order is what you actually work in.
  it("puts the files you work in first before anything is typed", async () => {
    saveFrecency(note({}, REPO, `${REPO}/src/beta.ts`, "edit", Date.now()));
    open();
    await waitFor(() => expect(screen.getByText("src/beta.ts")).toBeTruthy());
    expect(rowLabels()).toEqual(["src/beta.ts", "src/alpha.ts"]);
  });

  it("offers a worked-in file once, not in two blocks", () => {
    // It heads the list under "Recent files" and is the top of the ranked
    // project list too; a row for each would read as a bug however sensible
    // both halves are alone.
    saveFrecency(note({}, REPO, `${REPO}/src/beta.ts`, "edit", Date.now()));
    open();
    return waitFor(() => {
      expect(rowLabels().filter((l) => l === "src/beta.ts")).toHaveLength(1);
    });
  });

  it("leaves a typed query to the fuzzy score, not to what you opened last", async () => {
    saveFrecency(note({}, REPO, `${REPO}/src/beta.ts`, "edit", Date.now()));
    open();
    await waitFor(() => expect(screen.getByText("src/beta.ts")).toBeTruthy());

    typeInto("alpha");

    expect(rowLabels()).toEqual(["src/alpha.ts"]);
  });

  it("ranks on the project's own order when nothing has been worked in yet", async () => {
    open();
    await waitFor(() => expect(screen.getByText("src/alpha.ts")).toBeTruthy());
    expect(rowLabels()).toEqual(["src/alpha.ts", "src/beta.ts"]);
  });
});

describe("the empty box's recent blocks", () => {
  /** Remember working in these, newest last. */
  function worked(...rels: string[]) {
    const now = Date.now();
    let store = {};
    rels.forEach((rel, i) => {
      store = note(store, REPO, `${REPO}/${rel}`, "edit", now - (rels.length - i) * 1000);
    });
    saveFrecency(store);
  }

  it("leads with where the jump list has just been, file and symbol alike", () => {
    // Phase 2's list, published by the editor. A bare path is a file that was
    // opened; a path with a line is where a symbol was jumped to, and the two
    // are different destinations.
    publishEditorState({
      activePath: PATH,
      dirty: false,
      tabCount: 1,
      projectRoot: REPO,
      recentJumps: [{ path: `${REPO}/src/gamma.ts`, line: 42 }, { path: `${REPO}/src/delta.ts` }],
    });
    worked("src/hot.ts");
    open();

    expect(screen.getByText("Recently visited")).toBeTruthy();
    expect(rowLabels().slice(0, 3)).toEqual(["src/gamma.ts:42", "src/delta.ts", "src/hot.ts"]);
  });

  it("opens a jump target at the line it recorded", () => {
    publishEditorState({
      activePath: PATH,
      dirty: false,
      tabCount: 1,
      projectRoot: REPO,
      recentJumps: [{ path: `${REPO}/src/gamma.ts`, line: 42 }],
    });
    open();
    expect(fire("src/gamma.ts:42", OPEN_IN_EDITOR)).toEqual({ path: `${REPO}/src/gamma.ts`, line: 42 });
  });

  it("heads the list with the files worked in", () => {
    worked("src/old.ts", "src/hot.ts");
    open();
    expect(screen.getByText("Recent files")).toBeTruthy();
    expect(rowLabels().slice(0, 2)).toEqual(["src/hot.ts", "src/old.ts"]);
  });

  it("is absent entirely for a workspace nothing has been worked in", () => {
    open();
    expect(screen.queryByText("Recent files")).toBeNull();
    expect(screen.queryByText("Recently visited")).toBeNull();
  });

  it("goes away, heading and all, once a query filters its files out", () => {
    worked("src/hot.ts");
    open();
    expect(screen.getByText("Recent files")).toBeTruthy();

    typeInto("zzz");

    expect(screen.queryByText("Recent files")).toBeNull();
    expect(screen.queryByText("src/hot.ts")).toBeNull();
  });

  it("opens the file it names", () => {
    worked("src/hot.ts");
    open();
    expect(fire("src/hot.ts", OPEN_IN_EDITOR)).toEqual({ path: `${REPO}/src/hot.ts` });
  });

  // The listbox promises selectable children, and a heading is not one: it is
  // visible, but nothing in the accessibility tree may offer it, or the arrow
  // keys would appear to skip a row that was announced.
  it("keeps the headings out of the accessibility tree", () => {
    worked("src/hot.ts");
    open();
    const list = screen.getByRole("listbox");
    const announced = [...list.children].filter((el) => el.getAttribute("aria-hidden") !== "true");
    expect(announced).toHaveLength(screen.getAllByRole("option").length);
    expect(screen.getByText("Recent files").getAttribute("aria-hidden")).toBe("true");
  });
});

describe("> - actions", () => {
  it("lists no sessions, live or resumable", () => {
    // A chat mid-turn: live, named, and in the selected folder, which is exactly
    // what the old palette listed at the top as a "Focus" row.
    setLiveChat({
      sessionId: "chat-1",
      sessionName: "the running chat",
      folderPath: REPO,
      tabId: "tab-1",
      status: "executing",
      visible: false,
    });
    open(">");

    expect(rowLabels().filter((l) => l.includes("the running chat"))).toEqual(["Stop the running chat"]);
    expect(bridge.calls).not.toContain("list_sessions");
  });

  it.each([
    ["New Claude session", NEW_SESSION, { folderPath: REPO, projectName: "repo", agent: "claude" }],
    ["Show Changes", SET_RIGHT_MODE, { mode: "changes" }],
    // Labelled from the canonical table, which is the same string the ⌘/ sheet
    // shows: one command cannot be called two things.
    ["Show or hide the terminal", TOGGLE_TERMINAL, FIRED],
  ])("%s still runs", (label, event, want) => {
    open(">");
    expect(fire(label, event)).toEqual(want);
  });

  it("shows the key chips of a command that also carries a binding", () => {
    open(">");
    const row = screen.getByText("Show or hide the terminal").parentElement!;
    expect([...row.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["⌘", "⌥", "J"]);
  });

  it("lists an unavailable command with its reason, and refuses to run it", () => {
    // Nothing published means no file is open, so "Save file" has to say why
    // rather than either vanishing (you would never learn it exists) or running
    // and saving nothing.
    open(">");
    const row = screen.getByText("Save file").parentElement!;
    expect(row.textContent).toContain("No file open");
    expect(row.getAttribute("aria-disabled")).toBe("true");

    // Filtered down first, so the row Enter would take is unambiguously this one
    // rather than whatever happened to be at the top of the full list.
    typeInto(">Save file");
    expect(rowLabels()[0]).toBe("Save file");

    let fired = false;
    const on = () => (fired = true);
    window.addEventListener(EDITOR_SAVE, on);
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.click(screen.getByText("Save file"));
    window.removeEventListener(EDITOR_SAVE, on);
    expect(fired).toBe(false);
  });

  it("runs a command once its requirement is met", () => {
    publishEditorState({ activePath: PATH, dirty: true, tabCount: 1, projectRoot: REPO, recentJumps: [] });
    open(">");
    expect(screen.getByText("Save file").parentElement!.textContent).not.toContain("No file open");
    expect(fire("Save file", EDITOR_SAVE)).toEqual(FIRED);
  });

  it("closes before the command runs", () => {
    // Load-bearing for the commands whose handler opens a prompt (go to line,
    // commit): Editor is the prompt host, and a prompt raised while the box was
    // still up would open behind it and take its focus fight.
    const order: string[] = [];
    mounted = render(() => (
      <Omnibox
        prefix=">"
        selected={selection}
        onOpenSettings={onOpenSettings}
        onClose={() => order.push("closed")}
      />
    ));
    const on = () => order.push("ran");
    window.addEventListener(SET_RIGHT_MODE, on);
    fireEvent.click(screen.getByText("Show Changes"));
    window.removeEventListener(SET_RIGHT_MODE, on);
    expect(order).toEqual(["closed", "ran"]);
  });

  it("refuses Commit and Push by naming what is missing", () => {
    publishEditorState({ activePath: PATH, dirty: false, tabCount: 1, projectRoot: REPO, recentJumps: [] });
    open(">");
    expect(screen.getByText("Commit staged changes").parentElement!.textContent).toContain("Nothing staged");
    expect(screen.getByText("Push to origin").parentElement!.textContent).toContain("Nothing to push");
  });

  it("stops a running chat", () => {
    setLiveChat({
      sessionId: "chat-1",
      sessionName: "the running chat",
      folderPath: REPO,
      tabId: "tab-1",
      status: "waitingForApproval",
      visible: false,
    });
    open(">");
    expect(fire("Stop the running chat", STOP_CHAT)).toEqual({ sessionId: "chat-1" });
  });

  it("opens settings", () => {
    open(">");
    fireEvent.click(screen.getByText("Open Settings"));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("filters to the actions that match", () => {
    open(">");
    const all = rowLabels().length;
    typeInto(">sidebar");
    // fuzzyScore matches subsequences, so the narrowed list is not only exact
    // substring hits; what it must do is narrow, and rank both sidebar rows in.
    expect(rowLabels().length).toBeLessThan(all);
    expect(rowLabels()).toContain("Show or hide the sidebar");
    expect(rowLabels()).toContain("Filter the sidebar");
  });
});

describe("@ - the open file's symbols", () => {
  beforeEach(() => {
    publishEditorState({ activePath: PATH, dirty: false, tabCount: 1, projectRoot: REPO, recentJumps: [] });
  });

  it("lists them in document order before anything is typed", () => {
    publishSymbols(PATH, TREE);
    open("@");
    expect(rowLabels()).toEqual(["Thing", "gogo", "helper"]);
  });

  it("filters by name", () => {
    publishSymbols(PATH, TREE);
    open("@");
    typeInto("@hel");
    expect(rowLabels()).toEqual(["helper"]);
  });

  it("jumps to the symbol's name on Enter", () => {
    publishSymbols(PATH, TREE);
    open("@");
    typeInto("@gogo");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(opened).toEqual([{ path: PATH, line: 2, col: 3 }]);
  });

  it("says the file has no symbols rather than showing an empty list", () => {
    open("@");
    expect(screen.getByText("No symbols in the open file")).toBeTruthy();
  });

  it("reads the active file, not the one the box was opened over", () => {
    const other = `${REPO}/src/other.ts`;
    publishSymbols(PATH, TREE);
    publishSymbols(other, normalizeDocumentSymbols([{ name: "elsewhere", kind: 12, range: range(0, 0, 1, 0), selectionRange: range(0, 0, 0, 9) }], other));
    open("@");
    publishEditorState({ activePath: other, dirty: false, tabCount: 1, projectRoot: REPO, recentJumps: [] });
    expect(rowLabels()).toEqual(["elsewhere"]);
  });
});

describe("# - the project's symbols", () => {
  const HITS = normalizeWorkspaceSymbols(
    [
      { name: "Widget", kind: 5, location: { uri: `file://${REPO}/src/w.ts`, range: range(3, 0, 3, 6) }, containerName: "ui" },
    ],
    toPath,
  );

  beforeEach(() => {
    vi.useFakeTimers();
    offSearch = setWorkspaceSymbolSearch(async (q) => {
      searched.push(q);
      return HITS;
    });
  });
  afterEach(() => vi.useRealTimers());

  async function settle() {
    await vi.advanceTimersByTimeAsync(200);
  }

  it("asks the servers and lists what comes back", async () => {
    open("#");
    typeInto("#Wid");
    await settle();
    expect(searched).toEqual(["Wid"]);
    expect(rowLabels()).toEqual(["Widget"]);
  });

  it("opens the file at the symbol on Enter", async () => {
    open("#");
    typeInto("#Wid");
    await settle();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(opened).toEqual([{ path: `${REPO}/src/w.ts`, line: 4, col: 1 }]);
  });

  it("sends nothing until there is something to search for", async () => {
    open("#");
    await settle();
    expect(searched).toEqual([]);
    expect(screen.getByText("Type to search project symbols")).toBeTruthy();
  });

  it("debounces, so a typed word is one round trip and not five", async () => {
    open("#");
    for (const q of ["#W", "#Wi", "#Wid", "#Widg", "#Widge"]) typeInto(q);
    await settle();
    expect(searched).toEqual(["Widge"]);
  });

  it("sends nothing once the box is closed", async () => {
    open("#");
    typeInto("#Wid");
    mounted!.unmount();
    mounted = null;
    await settle();
    expect(searched).toEqual([]);
  });

  it("degrades to an empty list, not an error, with no server to ask", async () => {
    // The registered search is what an editor installs. Without one the honest
    // answer is that nothing is running, and it has to be an answer rather than
    // a rejected promise the box never recovers from.
    offSearch?.();
    offSearch = undefined;
    open("#");
    typeInto("#far");
    await settle();
    expect(screen.getByText("No matching symbols")).toBeTruthy();
  });

  it("shows an empty list rather than the previous query's hits while one is in flight", async () => {
    open("#");
    typeInto("#Wid");
    await settle();
    expect(rowLabels()).toEqual(["Widget"]);

    typeInto("#Other");

    expect(rowLabels()).toEqual([]);
  });
});

describe(": - go to line", () => {
  it("offers the line the query names", () => {
    publishEditorState({ activePath: PATH, dirty: false, tabCount: 1, projectRoot: REPO, recentJumps: [] });
    open(":");
    typeInto(":120");
    expect(rowLabels()).toEqual(["Go to line 120"]);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(opened).toEqual([{ path: PATH, line: 120, col: undefined }]);
  });

  it("waits rather than guessing at what is not a line number", () => {
    publishEditorState({ activePath: PATH, dirty: false, tabCount: 1, projectRoot: REPO, recentJumps: [] });
    open(":");
    expect(screen.getByText("Type a line number")).toBeTruthy();
    typeInto(":abc");
    expect(rowLabels()).toEqual([]);
  });

  it("says there is nothing to go to a line in when no file is open", () => {
    open(":");
    typeInto(":120");
    expect(screen.getByText("No file open")).toBeTruthy();
  });
});
