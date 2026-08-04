import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@solidjs/testing-library";

// ⌘P's three modes. The file finder is unchanged; what is new is that a leading
// `@` searches the open file's symbols and a leading `#` searches every running
// server's, and that neither of them can reach the editor directly: the store
// and the registered search are the whole of the connection.

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) =>
    cmd === "list_project_files"
      ? Promise.resolve(["src/alpha.ts", "src/beta.ts"])
      : Promise.resolve(null),
}));

const QuickOpen = (await import("./QuickOpen")).default;
const {
  publishSymbols,
  clearSymbols,
  normalizeDocumentSymbols,
  normalizeWorkspaceSymbols,
  setWorkspaceSymbolSearch,
} = await import("../../utils/symbols");
const { publishEditorState, clearEditorState } = await import("../../utils/editorState");
const { onWith, OPEN_IN_EDITOR } = await import("../../utils/events");
const { note, saveFrecency } = await import("../../utils/frecency");
type OpenInEditor = { path: string; line?: number; col?: number };

const PATH = "/proj/src/alpha.ts";

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
      children: [
        { name: "gogo", kind: 6, range: range(1, 2, 3, 3), selectionRange: range(1, 2, 1, 6) },
      ],
    },
    { name: "helper", kind: 12, range: range(8, 0, 10, 1), selectionRange: range(8, 9, 8, 15) },
  ],
  PATH,
);

const toPath = (uri: string) => (uri.startsWith("file://") ? uri.slice("file://".length) : null);

let searched: string[] = [];
let opened: OpenInEditor[] = [];
let offOpen: (() => void) | undefined;
let offSearch: (() => void) | undefined;

function typeInto(value: string) {
  const input = screen.getByPlaceholderText(/Go to file/);
  fireEvent.input(input, { target: { value } });
  return input;
}

/** The rows on screen, in the order they are offered. */
function rowLabels(): string[] {
  return [...document.querySelectorAll("[class*=qoName]")].map((el) => el.textContent ?? "");
}

beforeEach(() => {
  // The ranking is read from storage, which jsdom keeps between tests in a
  // file: a leftover record would decide another test's order.
  localStorage.clear();
  clearSymbols();
  clearEditorState();
  searched = [];
  opened = [];
  offOpen = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => opened.push(d));
  publishEditorState({ activePath: PATH, dirty: false, tabCount: 1, projectRoot: "/proj" });
});

afterEach(() => {
  offOpen?.();
  offSearch?.();
  offSearch = undefined;
  clearSymbols();
  clearEditorState();
});

describe("the file finder", () => {
  it("still lists files with no prefix", async () => {
    render(() => <QuickOpen root="/proj" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("src/alpha.ts")).toBeTruthy());
    typeInto("beta");
    expect(screen.queryByText("src/alpha.ts")).toBeNull();
    expect(screen.getByText("src/beta.ts")).toBeTruthy();
  });

  it("opens a file relative to the project root", async () => {
    render(() => <QuickOpen root="/proj" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("src/beta.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("src/beta.ts"));
    expect(opened).toEqual([{ path: "/proj/src/beta.ts" }]);
  });

  // The empty box is the one the ranking is for: with nothing typed there is no
  // query to sort by, so the only useful order is what you actually work in.
  it("puts the files you work in first before anything is typed", async () => {
    // `beta` sorts second in the project's own order; one edit is enough to
    // outrank a file with no record at all.
    saveFrecency(note({}, "/proj", "/proj/src/beta.ts", "edit", Date.now()));

    render(() => <QuickOpen root="/proj" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText("src/beta.ts")).toBeTruthy());
    expect(rowLabels()).toEqual(["src/beta.ts", "src/alpha.ts"]);
  });

  it("leaves a typed query to the fuzzy score, not to what you opened last", async () => {
    saveFrecency(note({}, "/proj", "/proj/src/beta.ts", "edit", Date.now()));
    render(() => <QuickOpen root="/proj" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("src/beta.ts")).toBeTruthy());

    typeInto("alpha");

    expect(rowLabels()).toEqual(["src/alpha.ts"]);
  });

  it("ranks on the project's own order when nothing has been worked in yet", async () => {
    render(() => <QuickOpen root="/proj" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("src/alpha.ts")).toBeTruthy());
    expect(rowLabels()).toEqual(["src/alpha.ts", "src/beta.ts"]);
  });
});

describe("@ - the open file's symbols", () => {
  it("lists them in document order before anything is typed", () => {
    publishSymbols(PATH, TREE);
    render(() => <QuickOpen root="/proj" onClose={() => {}} />);
    typeInto("@");
    // Files are gone, symbols are here, and children are listed alongside their
    // parents rather than hidden inside them.
    expect(screen.queryByText("src/alpha.ts")).toBeNull();
    expect(screen.getByText("Thing")).toBeTruthy();
    expect(screen.getByText("gogo")).toBeTruthy();
    expect(screen.getByText("helper")).toBeTruthy();
  });

  it("filters by name", () => {
    publishSymbols(PATH, TREE);
    render(() => <QuickOpen root="/proj" onClose={() => {}} />);
    typeInto("@help");
    expect(screen.getByText("helper")).toBeTruthy();
    expect(screen.queryByText("Thing")).toBeNull();
  });

  it("jumps to the symbol's name on Enter", () => {
    publishSymbols(PATH, TREE);
    render(() => <QuickOpen root="/proj" onClose={() => {}} />);
    const input = typeInto("@gogo");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(opened).toEqual([{ path: PATH, line: 2, col: 3 }]);
  });

  it("says the file has no symbols rather than showing an empty list", () => {
    publishSymbols(PATH, []);
    render(() => <QuickOpen root="/proj" onClose={() => {}} />);
    typeInto("@");
    expect(screen.getByText("No symbols in the open file")).toBeTruthy();
  });

  it("reads the active file, not the one the palette was opened over", () => {
    // The store is keyed by path and `editorState` names which one is on
    // screen; nothing here can see the editor itself.
    publishSymbols(PATH, TREE);
    publishSymbols("/proj/src/beta.ts", []);
    publishEditorState({ activePath: "/proj/src/beta.ts", dirty: false, tabCount: 2, projectRoot: "/proj" });
    render(() => <QuickOpen root="/proj" onClose={() => {}} />);
    typeInto("@");
    expect(screen.queryByText("Thing")).toBeNull();
  });
});

describe("# - the project's symbols", () => {
  function serve(hits: { name: string; path: string; line: number }[]) {
    offSearch = setWorkspaceSymbolSearch(async (q) => {
      searched.push(q);
      return normalizeWorkspaceSymbols(
        hits.map((h) => ({
          name: h.name,
          kind: 12,
          location: { uri: `file://${h.path}`, range: range(h.line, 0, h.line, 5) },
        })),
        toPath,
      );
    });
  }

  it("asks the servers and lists what comes back", async () => {
    serve([{ name: "farAway", path: "/proj/src/never-opened.ts", line: 41 }]);
    render(() => <QuickOpen root="/proj" onClose={() => {}} />);
    typeInto("#far");
    // Hits from a file that was never opened, which is the whole point of the
    // mode: the document-symbol store only ever holds the active file.
    await waitFor(() => expect(screen.getByText("farAway")).toBeTruthy());
    expect(searched).toEqual(["far"]);
  });

  it("opens the file at the symbol on Enter", async () => {
    serve([{ name: "farAway", path: "/proj/src/never-opened.ts", line: 41 }]);
    render(() => <QuickOpen root="/proj" onClose={() => {}} />);
    const input = typeInto("#far");
    await waitFor(() => expect(screen.getByText("farAway")).toBeTruthy());
    fireEvent.keyDown(input, { key: "Enter" });
    expect(opened).toEqual([{ path: "/proj/src/never-opened.ts", line: 42, col: 1 }]);
  });

  it("sends nothing until there is something to search for", () => {
    serve([]);
    render(() => <QuickOpen root="/proj" onClose={() => {}} />);
    typeInto("#");
    expect(screen.getByText("Type to search project symbols")).toBeTruthy();
    expect(searched).toEqual([]);
  });

  it("debounces, so a typed word is one round trip and not five", async () => {
    serve([{ name: "farAway", path: "/proj/x.ts", line: 0 }]);
    render(() => <QuickOpen root="/proj" onClose={() => {}} />);
    for (const q of ["#f", "#fa", "#far"]) typeInto(q);
    await waitFor(() => expect(screen.getByText("farAway")).toBeTruthy());
    expect(searched).toEqual(["far"]);
  });

  it("sends nothing once the palette is closed", async () => {
    // Esc inside the debounce window would otherwise still cost a round trip to
    // every live server, for a palette nobody is looking at.
    serve([{ name: "farAway", path: "/proj/x.ts", line: 0 }]);
    const { unmount } = render(() => <QuickOpen root="/proj" onClose={() => {}} />);
    typeInto("#far");
    unmount();
    await new Promise((r) => setTimeout(r, 300));
    expect(searched).toEqual([]);
  });

  it("shows an empty list rather than the previous query's hits while one is in flight", () => {
    serve([{ name: "farAway", path: "/proj/x.ts", line: 0 }]);
    render(() => <QuickOpen root="/proj" onClose={() => {}} />);
    typeInto("#far");
    // Nothing has resolved yet: showing the last answer under new text is how a
    // palette gets somebody to press Enter on the wrong row.
    expect(screen.queryByText("farAway")).toBeNull();
  });

  it("shows nothing when no editor is mounted to ask", async () => {
    // No registered search: the honest answer is that no server is running.
    render(() => <QuickOpen root="/proj" onClose={() => {}} />);
    typeInto("#far");
    await waitFor(() => expect(screen.getByText("No matching symbols")).toBeTruthy());
  });
});
