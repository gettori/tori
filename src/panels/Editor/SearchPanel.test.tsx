import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";

// The Search panel's controls, driven through the real component. Match
// semantics belong to the backend's one canonical regex, so what is asserted
// here is strictly the panel's own job: which options it sends, when it
// re-searches, what it disables, and how it renders the spans it is handed.

type Options = {
  case: boolean;
  regex: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
  noIgnore: boolean;
};
type Call = { query: string; options: Options };

type ReplaceCall = {
  root: string;
  query: string;
  options: Options;
  replacement: string;
  targets: { path: string; digest: string; matches: { line: number; start: number; end: number }[] }[];
};

const bridge: {
  calls: Call[];
  replaces: ReplaceCall[];
  previews: { replacement: string; options: Options; spans: unknown[] }[];
  respond: (query: string, options: Options) => unknown;
  replaceResult: () => unknown;
  previewResult: (replacement: string, spans: { text: string; start: number; end: number }[]) => unknown;
} = {
  calls: [],
  replaces: [],
  previews: [],
  respond: () => ({ matches: [], truncated: false, backend: "rg", unsupported: [], files: [] }),
  replaceResult: () => ({ changed: [], skipped: [], occurrences: 0 }),
  // Stands in for the Rust expansion: the panel must render whatever comes
  // back, never compute it itself.
  previewResult: (replacement, spans) => spans.map(() => replacement.toUpperCase()),
};

const markSelfWrite = vi.fn();
vi.mock("../../utils/selfWrites", () => ({
  markSelfWrite: (p: string) => markSelfWrite(p),
  isSelfWrite: () => false,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "preview_replace") {
      bridge.previews.push({
        replacement: args.replacement as string,
        options: args.options as Options,
        spans: args.spans as unknown[],
      });
      return Promise.resolve(
        bridge.previewResult(
          args.replacement as string,
          args.spans as { text: string; start: number; end: number }[],
        ),
      );
    }
    if (cmd === "replace_in_files") {
      bridge.replaces.push(args as unknown as ReplaceCall);
      try {
        return Promise.resolve(bridge.replaceResult());
      } catch (e) {
        return Promise.reject(e);
      }
    }
    if (cmd !== "grep_project") return Promise.resolve(null);
    const query = args.query as string;
    const options = args.options as Options;
    bridge.calls.push({ query, options });
    try {
      return Promise.resolve(bridge.respond(query, options));
    } catch (e) {
      return Promise.reject(e);
    }
  },
}));
const fsHandlers: Record<string, ((e: { payload: unknown }) => void) | undefined> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, fn: (e: { payload: unknown }) => void) => {
    fsHandlers[name] = fn;
    return Promise.resolve(() => {});
  },
  emit: () => Promise.resolve(),
}));

import SearchPanel from "./SearchPanel";

const match = (text: string, submatches: [number, number][], line = 1, path = "src/a.ts") => ({
  path,
  line,
  text,
  submatches,
});
const ok = (matches: ReturnType<typeof match>[], extra: Record<string, unknown> = {}) => ({
  matches,
  truncated: false,
  backend: "rg",
  unsupported: [],
  files: [],
  ...extra,
});

function mount(extra: Partial<Parameters<typeof SearchPanel>[0]> = {}) {
  return render(() => <SearchPanel root="/proj" focusNonce={0} {...extra} />);
}

const ONE_FILE = (path = "src/a.ts") =>
  ok([match("ab cd ab", [[0, 2], [6, 8]], 1, path)], {
    files: [{ path, digest: "d1" }],
  });

/** Open the replace row and type a replacement, waiting for its preview. */
async function typeReplacement(value: string) {
  fireEvent.click(screen.getByLabelText("Toggle replace"));
  fireEvent.input(screen.getByLabelText("Replace with"), { target: { value } });
  await waitFor(() => expect(bridge.previews.length).toBeGreaterThan(0));
}

/** The searches the panel actually ran, ignoring the empty-query capability
 *  probe it fires on mount. */
const searches = () => bridge.calls.filter((c) => c.query !== "");

async function type(value: string) {
  const input = screen.getByPlaceholderText("Search project") as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
  // Wait for *this* query, not for "a search happened". Any stray call - a
  // debounce that outlived an earlier test, a refresh - would otherwise satisfy
  // the wait before this query had even been sent, and the test would go on to
  // click Replace all against results that do not exist yet. That is what made
  // "retires it when a toggle changes too" fail on CI roughly one run in twenty
  // while passing everywhere else.
  await waitFor(() => expect(searches().some((c) => c.query === value)).toBe(true));
}

beforeEach(() => {
  // The history and the saved list are read from storage on mount, so a test
  // that did not put something there must not inherit it from one that did.
  localStorage.clear();
  bridge.calls = [];
  bridge.replaces = [];
  bridge.previews = [];
  bridge.respond = () => ok([]);
  bridge.replaceResult = () => ({ changed: [], skipped: [], occurrences: 0 });
  bridge.previewResult = (replacement, spans) => spans.map(() => replacement.toUpperCase());
  markSelfWrite.mockClear();
});

describe("capability probe", () => {
  it("asks what the backend supports before the first query", async () => {
    mount();
    await waitFor(() => expect(bridge.calls.some((c) => c.query === "")).toBe(true));
  });

  it("disables an unsupported toggle and says why", async () => {
    bridge.respond = () => ok([], { backend: "plain", unsupported: ["noIgnore"] });
    mount();

    const ignored = () => screen.getByLabelText("Search ignored files") as HTMLButtonElement;
    await waitFor(() => expect(ignored().disabled).toBe(true));
    // A disabled control with no explanation is barely better than an inert one.
    expect(ignored().title).toContain("no ignore rules");

    // The toggles the plain backend *can* honour stay live.
    expect((screen.getByLabelText("Match case") as HTMLButtonElement).disabled).toBe(false);
  });

  it("leaves every toggle enabled when the backend honours them all", async () => {
    mount();
    await waitFor(() => expect(bridge.calls.length).toBeGreaterThan(0));
    for (const label of ["Match case", "Match whole word", "Use regular expression", "Search ignored files"]) {
      expect((screen.getByLabelText(label) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("keeps controls usable when the probe itself fails", async () => {
    bridge.respond = () => {
      throw new Error("backend exploded");
    };
    mount();
    await waitFor(() => expect(bridge.calls.length).toBeGreaterThan(0));
    expect((screen.getByLabelText("Search ignored files") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("toggles", () => {
  it("reflects pressed state and sends the option", async () => {
    mount();
    await type("needle");
    expect(searches()[0].options.case).toBe(false);

    const caseBtn = screen.getByLabelText("Match case") as HTMLButtonElement;
    expect(caseBtn.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(caseBtn);
    await waitFor(() => expect(searches().length).toBe(2));
    expect(searches()[1].options.case).toBe(true);
    expect(caseBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("re-searches immediately, without waiting out the input debounce", async () => {
    // A toggle is one deliberate act. If it went through the 200ms input
    // debounce this would still be at one call when the assertion runs.
    mount();
    await type("needle");
    const before = searches().length;
    fireEvent.click(screen.getByLabelText("Use regular expression"));
    await waitFor(() => expect(searches().length).toBe(before + 1));
  });

  it("sends each toggle under the name the backend expects", async () => {
    mount();
    await type("needle");
    for (const [label, key] of [
      ["Match case", "case"],
      ["Match whole word", "wholeWord"],
      ["Use regular expression", "regex"],
      ["Search ignored files", "noIgnore"],
    ] as const) {
      const n = searches().length;
      fireEvent.click(screen.getByLabelText(label));
      await waitFor(() => expect(searches().length).toBe(n + 1));
      expect(searches()[searches().length - 1].options[key]).toBe(true);
    }
  });
});

describe("glob inputs", () => {
  it("stay hidden until the disclosure is opened", async () => {
    mount();
    await waitFor(() => expect(bridge.calls.length).toBeGreaterThan(0));
    expect(screen.queryByPlaceholderText("Include, e.g. src/**/*.ts")).toBeNull();

    fireEvent.click(screen.getByLabelText("Include and exclude globs"));
    expect(screen.getByPlaceholderText("Include, e.g. src/**/*.ts")).toBeTruthy();
    expect(screen.getByPlaceholderText("Exclude, e.g. **/*.test.ts")).toBeTruthy();
  });

  it("sends the globs, and clearing one restores the unfiltered search", async () => {
    mount();
    await type("needle");
    fireEvent.click(screen.getByLabelText("Include and exclude globs"));

    const include = screen.getByPlaceholderText("Include, e.g. src/**/*.ts");
    fireEvent.input(include, { target: { value: "src/**/*.ts" } });
    await waitFor(() =>
      expect(searches()[searches().length - 1].options.include).toBe("src/**/*.ts"),
    );

    fireEvent.input(include, { target: { value: "" } });
    await waitFor(() => expect(searches()[searches().length - 1].options.include).toBe(""));
  });
});

describe("errors", () => {
  it("shows the backend's message and never a false 'No matches'", async () => {
    bridge.respond = (q) => {
      if (q === "[") throw new Error("regex parse error: unclosed character class");
      return ok([match("needle here", [[0, 6]])]);
    };
    const { container } = mount();

    // A highlighted line is split across a <mark> and its sibling text node, so
    // the row is asserted through textContent rather than getByText.
    await type("needle");
    await waitFor(() => expect(container.textContent).toContain("needle here"));

    const input = screen.getByPlaceholderText("Search project");
    fireEvent.input(input, { target: { value: "[" } });

    await waitFor(() => expect(screen.getByText(/unclosed character class/)).toBeTruthy());
    expect(screen.queryByText("No matches")).toBeNull();
    // The previous pattern's hits must not sit under an error about a different
    // pattern, reading as though they matched it.
    expect(container.textContent).not.toContain("needle here");
  });

  it("keeps results when a background refresh fails", async () => {
    // A transient failure while re-running the *same* query must not blank a
    // good result set: what is on screen is still the honest answer.
    let failing = false;
    bridge.respond = () => {
      if (failing) throw new Error("transient backend failure");
      return ok([match("needle here", [[0, 6]])]);
    };
    const { container } = mount();
    await type("needle");
    await waitFor(() => expect(container.textContent).toContain("needle here"));

    failing = true;
    fsHandlers["fs://changed"]?.({ payload: { paths: ["/proj/src/a.ts"] } });

    await waitFor(() => expect(screen.getByText(/transient backend failure/)).toBeTruthy());
    expect(container.textContent).toContain("needle here");
  });
});

describe("a11y", () => {
  it("names the glob inputs and marks the disclosure as expandable", async () => {
    mount();
    await waitFor(() => expect(bridge.calls.length).toBeGreaterThan(0));

    const disclosure = screen.getByLabelText("Include and exclude globs");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    // Placeholders are not an accessible name; these inputs carry their own.
    expect(screen.getByLabelText("Include files matching these globs")).toBeTruthy();
    expect(screen.getByLabelText("Exclude files matching these globs")).toBeTruthy();
  });
});

describe("truncation notice", () => {
  it("says nothing when the results fit", async () => {
    bridge.respond = () => ok([match("needle", [[0, 6]])]);
    mount();
    await type("needle");
    await waitFor(() => expect(screen.getByText(/needle/)).toBeTruthy());
    expect(screen.queryByText(/Refine your search/)).toBeNull();
  });

  it("counts occurrences separately from matching lines", async () => {
    // Two rows, three spans: the cap counts lines, a replace acts on spans, so
    // the notice must not use one number for both.
    bridge.respond = () =>
      ok([match("ab cd ab", [[0, 2], [6, 8]]), match("ab", [[0, 2]], 2)], { truncated: true });
    mount();
    await type("ab");
    await waitFor(() => expect(screen.getByText(/Refine your search/)).toBeTruthy());
    expect(screen.getByText(/3 occurrences/)).toBeTruthy();
    expect(screen.getByText(/First 500 matching lines/)).toBeTruthy();
  });
});

describe("replace preview", () => {
  it("renders the expansion the backend returned, not one it computed", async () => {
    bridge.respond = () => ONE_FILE();
    bridge.previewResult = () => ["FROM-BACKEND", "FROM-BACKEND"];
    const { container } = mount();
    await type("ab");
    await typeReplacement("zz");

    await waitFor(() => expect(container.querySelectorAll("ins").length).toBe(2));
    expect(Array.from(container.querySelectorAll("ins")).map((n) => n.textContent)).toEqual([
      "FROM-BACKEND",
      "FROM-BACKEND",
    ]);
    // The old span stays visible, struck through, beside the new text.
    expect(Array.from(container.querySelectorAll("del")).map((n) => n.textContent)).toEqual([
      "ab",
      "ab",
    ]);
  });

  it("asks once per debounce rather than once per keystroke", async () => {
    bridge.respond = () => ONE_FILE();
    mount();
    await type("ab");
    fireEvent.click(screen.getByLabelText("Toggle replace"));

    const input = screen.getByLabelText("Replace with");
    for (const v of ["z", "zz", "zzz"]) fireEvent.input(input, { target: { value: v } });
    await waitFor(() => expect(bridge.previews.length).toBeGreaterThan(0));
    expect(bridge.previews.length).toBe(1);
    expect(bridge.previews[0].replacement).toBe("zzz");
  });

  it("shows no preview for a span the backend could not expand", async () => {
    bridge.respond = () => ONE_FILE();
    bridge.previewResult = () => ["ok", null];
    const { container } = mount();
    await type("ab");
    await typeReplacement("zz");
    await waitFor(() => expect(container.querySelectorAll("ins").length).toBe(1));
  });

  it("asks preview and replace the same question", async () => {
    // Byte-identical output is the backend's property; that the panel sends
    // both commands the same options and replacement is this layer's.
    bridge.respond = () => ONE_FILE();
    mount({ confirm: () => Promise.resolve(true) });
    await type("ab");
    fireEvent.click(screen.getByLabelText("Use regular expression"));
    await waitFor(() => expect(searches().length).toBe(2));
    await typeReplacement("X$1");

    fireEvent.click(screen.getByLabelText("Replace all"));
    await waitFor(() => expect(bridge.replaces.length).toBe(1));

    const preview = bridge.previews[bridge.previews.length - 1];
    const replace = bridge.replaces[0];
    expect(replace.replacement).toBe(preview.replacement);
    expect(replace.options).toEqual(preview.options);
    expect(replace.query).toBe("ab");
  });
});

describe("replace scopes", () => {
  const TWO_FILES = () =>
    ok(
      [
        match("ab cd ab", [[0, 2], [6, 8]], 1, "src/a.ts"),
        match("ab", [[0, 2]], 4, "src/b.ts"),
      ],
      {
        files: [
          { path: "src/a.ts", digest: "d1" },
          { path: "src/b.ts", digest: "d2" },
        ],
      },
    );

  it("Replace All sends every file's spans", async () => {
    bridge.respond = TWO_FILES;
    mount({ confirm: () => Promise.resolve(true) });
    await type("ab");
    await typeReplacement("zz");

    fireEvent.click(screen.getByLabelText("Replace all"));
    await waitFor(() => expect(bridge.replaces.length).toBe(1));
    expect(bridge.replaces[0].targets).toEqual([
      {
        path: "src/a.ts",
        digest: "d1",
        matches: [
          { line: 1, start: 0, end: 2 },
          { line: 1, start: 6, end: 8 },
        ],
      },
      { path: "src/b.ts", digest: "d2", matches: [{ line: 4, start: 0, end: 2 }] },
    ]);
  });

  it("per-file sends only that file's spans", async () => {
    bridge.respond = TWO_FILES;
    mount();
    await type("ab");
    await typeReplacement("zz");

    fireEvent.click(screen.getByLabelText("Replace in src/b.ts"));
    await waitFor(() => expect(bridge.replaces.length).toBe(1));
    expect(bridge.replaces[0].targets).toEqual([
      { path: "src/b.ts", digest: "d2", matches: [{ line: 4, start: 0, end: 2 }] },
    ]);
  });

  it("per-match sends exactly one span", async () => {
    bridge.respond = TWO_FILES;
    mount();
    await type("ab");
    await typeReplacement("zz");

    // Per-match buttons appear only once the preview has been applied, so wait
    // for the render rather than just the request.
    await waitFor(() =>
      expect(screen.getAllByLabelText("Replace this occurrence on line 1").length).toBe(2),
    );
    // The second occurrence on line 1 of a.ts, not the first.
    const buttons = screen.getAllByLabelText("Replace this occurrence on line 1");
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(bridge.replaces.length).toBe(1));
    expect(bridge.replaces[0].targets).toEqual([
      { path: "src/a.ts", digest: "d1", matches: [{ line: 1, start: 6, end: 8 }] },
    ]);
  });

  it("disables Replace All while the results are capped", async () => {
    // A capped set is a subset, so "replace everything" would quietly mean
    // "replace the first 500".
    bridge.respond = () =>
      ok([match("ab", [[0, 2]], 1, "src/a.ts")], {
        truncated: true,
        files: [{ path: "src/a.ts", digest: "d1" }],
      });
    mount();
    await type("ab");
    await typeReplacement("zz");
    expect((screen.getByLabelText("Replace all") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("replace confirmation", () => {
  it("writes nothing when the confirm is declined", async () => {
    bridge.respond = () => ONE_FILE();
    const confirm = vi.fn(() => Promise.resolve(false));
    mount({ confirm });
    await type("ab");
    await typeReplacement("zz");

    fireEvent.click(screen.getByLabelText("Replace all"));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(bridge.replaces).toEqual([]);
  });

  it("writes once when accepted, and names both counts in the prompt", async () => {
    bridge.respond = () => ONE_FILE();
    const seen: { title: string }[] = [];
    const confirm = (opts: { title: string }) => {
      seen.push(opts);
      return Promise.resolve(true);
    };
    mount({ confirm });
    await type("ab");
    await typeReplacement("zz");

    fireEvent.click(screen.getByLabelText("Replace all"));
    await waitFor(() => expect(bridge.replaces.length).toBe(1));
    expect(seen[0].title).toBe("Replace 2 occurrences in 1 file?");
  });
});

describe("dirty buffers", () => {
  it("leaves a file with unsaved edits out of the targets and reports it skipped", async () => {
    bridge.respond = () =>
      ok(
        [
          match("ab", [[0, 2]], 1, "src/a.ts"),
          match("ab", [[0, 2]], 1, "src/b.ts"),
        ],
        {
          files: [
            { path: "src/a.ts", digest: "d1" },
            { path: "src/b.ts", digest: "d2" },
          ],
        },
      );
    bridge.replaceResult = () => ({ changed: ["src/b.ts"], skipped: [], occurrences: 1 });
    mount({
      confirm: () => Promise.resolve(true),
      // Absolute-keyed, with a saved file left behind as `false`.
      dirty: { "/proj/src/a.ts": true, "/proj/src/b.ts": false },
    });
    await type("ab");
    await typeReplacement("zz");

    fireEvent.click(screen.getByLabelText("Replace all"));
    await waitFor(() => expect(bridge.replaces.length).toBe(1));
    expect(bridge.replaces[0].targets.map((t) => t.path)).toEqual(["src/b.ts"]);
    await waitFor(() => expect(screen.getByText(/unsaved changes/)).toBeTruthy());
  });
});

describe("self-writes", () => {
  it("never marks a replaced path, so an open clean buffer still reloads", async () => {
    // Marking would short-circuit CodeEditor's handleExternalChange, leaving a
    // clean tab showing pre-replace text whose next save reverts the replace.
    bridge.respond = () => ONE_FILE();
    bridge.replaceResult = () => ({ changed: ["src/a.ts"], skipped: [], occurrences: 2 });
    mount({ confirm: () => Promise.resolve(true) });
    await type("ab");
    await typeReplacement("zz");

    fireEvent.click(screen.getByLabelText("Replace all"));
    await waitFor(() => expect(bridge.replaces.length).toBe(1));
    expect(markSelfWrite).not.toHaveBeenCalled();
  });
});

describe("replace outcome", () => {
  it("re-searches after a replace and reports what happened", async () => {
    bridge.respond = () => ONE_FILE();
    bridge.replaceResult = () => ({
      changed: ["src/a.ts"],
      skipped: [{ path: "src/c.ts", reason: "changed on disk" }],
      occurrences: 2,
    });
    mount({ confirm: () => Promise.resolve(true) });
    await type("ab");
    await typeReplacement("zz");
    const before = searches().length;

    fireEvent.click(screen.getByLabelText("Replace all"));
    await waitFor(() => expect(bridge.replaces.length).toBe(1));

    // The re-search is what shows on screen that the write landed.
    await waitFor(() => expect(searches().length).toBe(before + 1));
    await waitFor(() =>
      expect(
        screen.getByText("Replaced 2 occurrences in 1 file, 1 skipped (changed on disk)."),
      ).toBeTruthy(),
    );
  });
});

describe("unmounting", () => {
  it("drops a debounced search the panel queued before it closed", async () => {
    bridge.respond = () => ONE_FILE();
    const { unmount } = mount();
    await waitFor(() => expect(bridge.calls.length).toBeGreaterThan(0));

    // Type, then close before the input debounce elapses.
    fireEvent.input(screen.getByPlaceholderText("Search project"), {
      target: { value: "gone" },
    });
    unmount();

    // Well past INPUT_DEBOUNCE_MS: the query must never reach the backend, and
    // a panel that leaks this fires it into whatever is running next.
    await new Promise((r) => setTimeout(r, 400));
    expect(bridge.calls.map((c) => c.query)).not.toContain("gone");
  });
});

describe("outcome staleness", () => {
  it("retires the outcome line when the query changes", async () => {
    // A success line hanging over unrelated results reads as though it describes
    // them.
    bridge.respond = () => ONE_FILE();
    bridge.replaceResult = () => ({ changed: ["src/a.ts"], skipped: [], occurrences: 2 });
    mount({ confirm: () => Promise.resolve(true) });
    await type("ab");
    await typeReplacement("zz");

    fireEvent.click(screen.getByLabelText("Replace all"));
    await waitFor(() => expect(screen.getByText(/^Replaced 2 occurrences/)).toBeTruthy());

    fireEvent.input(screen.getByPlaceholderText("Search project"), {
      target: { value: "something else" },
    });
    await waitFor(() => expect(screen.queryByText(/^Replaced 2 occurrences/)).toBeNull());
  });

  it("retires it when a toggle changes too", async () => {
    bridge.respond = () => ONE_FILE();
    bridge.replaceResult = () => ({ changed: ["src/a.ts"], skipped: [], occurrences: 2 });
    mount({ confirm: () => Promise.resolve(true) });
    await type("ab");
    await typeReplacement("zz");

    fireEvent.click(screen.getByLabelText("Replace all"));
    await waitFor(() => expect(screen.getByText(/^Replaced 2 occurrences/)).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Match case"));
    await waitFor(() => expect(screen.queryByText(/^Replaced 2 occurrences/)).toBeNull());
  });
});

describe("preview after reopening the replace row", () => {
  it("re-requests the preview when the row is reopened", async () => {
    bridge.respond = () => ONE_FILE();
    const { container } = mount();
    await type("ab");
    await typeReplacement("zz");
    await waitFor(() => expect(container.querySelectorAll("ins").length).toBe(2));

    // Close, change the results underneath, reopen.
    fireEvent.click(screen.getByLabelText("Toggle replace"));
    await waitFor(() => expect(container.querySelectorAll("ins").length).toBe(0));
    fireEvent.input(screen.getByPlaceholderText("Search project"), { target: { value: "ab " } });
    await waitFor(() => expect(searches().length).toBeGreaterThan(1));

    fireEvent.click(screen.getByLabelText("Toggle replace"));
    // The replacement is still typed, so the preview must come back on its own.
    await waitFor(() => expect(container.querySelectorAll("ins").length).toBe(2));
  });
});

describe("concurrent replaces", () => {
  it("runs one at a time", async () => {
    bridge.respond = () => ONE_FILE();
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => (release = r));
    bridge.replaceResult = () => gate.then(() => ({ changed: ["src/a.ts"], skipped: [], occurrences: 2 }));
    mount({ confirm: () => Promise.resolve(true) });
    await type("ab");
    await typeReplacement("zz");

    const button = screen.getByLabelText("Replace all") as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(bridge.replaces.length).toBe(1));
    // The in-flight replace disables its own button, and a second click that
    // slipped through would still be refused.
    await waitFor(() => expect(button.disabled).toBe(true));
    fireEvent.click(button);
    expect(bridge.replaces.length).toBe(1);

    release(null);
    await waitFor(() => expect(button.disabled).toBe(false));
  });
});

describe("highlighting", () => {
  const marks = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("mark")).map((m) => m.textContent);

  it("highlights every occurrence on a line", async () => {
    bridge.respond = () => ok([match("ab cd ab", [[0, 2], [6, 8]])]);
    const { container } = mount();
    await type("ab");
    await waitFor(() => expect(marks(container).length).toBe(2));
    expect(marks(container)).toEqual(["ab", "ab"]);
  });

  it("lands on the right span when the line has non-ASCII before the match", async () => {
    // UTF-16 offsets, as the backend emits them. Byte offsets would highlight
    // one character late here, which is the bug this pins.
    bridge.respond = () => ok([match("café needle", [[5, 11]])]);
    const { container } = mount();
    await type("needle");
    await waitFor(() => expect(marks(container).length).toBe(1));
    expect(marks(container)).toEqual(["needle"]);
  });

  it("renders an unmatched line as plain text", async () => {
    bridge.respond = () => ok([match("no spans here", [])]);
    const { container } = mount();
    await type("x");
    await waitFor(() => expect(screen.getByText(/no spans here/)).toBeTruthy());
    expect(marks(container)).toEqual([]);
  });
});

describe("handing the results to an editable buffer", () => {
  const button = () => screen.getByLabelText("Edit results in a buffer");

  it("has nothing to hand over until something matched", async () => {
    mount();
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(true));
  });

  it("materialises the matches it is showing, as a tab", async () => {
    // The rows go across as the backend reported them, which is what lets the
    // buffer claim each row *is* a line of a file. Re-deriving them there would
    // give the write-back a second answer to be wrong about.
    bridge.respond = () => ok([match("const needle = 1", [[6, 12]], 12, "src/a.ts")]);
    mount();
    await type("needle");
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));

    const opened: string[] = [];
    const listener = (e: Event) => opened.push((e as CustomEvent).detail.path);
    window.addEventListener("sway:open-in-editor", listener);
    try {
      fireEvent.click(button());
    } finally {
      window.removeEventListener("sway:open-in-editor", listener);
    }

    const { searchBuffer } = await import("./searchResultsStore");
    expect(opened.length).toBe(1);
    const buf = searchBuffer(opened[0])!;
    expect(buf.doc.root).toBe("/proj");
    expect(buf.doc.rows).toContainEqual({
      kind: "match",
      file: "src/a.ts",
      line: 12,
      original: "const needle = 1",
    });
  });
});

// --- history and saved searches ---

const queryInput = () => screen.getByPlaceholderText("Search project") as HTMLInputElement;
const lastSearch = () => searches()[searches().length - 1];

/** Type a query and press Enter, which is what puts it in the history. */
async function commit(value: string) {
  await type(value);
  fireEvent.keyDown(queryInput(), { key: "Enter" });
  await waitFor(() => expect(lastSearch().query).toBe(value));
}

/** Open the saved-searches disclosure. */
function openSavedRow() {
  fireEvent.click(screen.getByLabelText("Saved searches"));
}

describe("query history", () => {
  it("recalls the last query, with the toggles it was run with", async () => {
    // The reason an entry is a (query, options) pair: handing back "alpha"
    // without the case flag it was run under is handing back a search the user
    // never ran, and the results would not be the ones they remember.
    mount();
    await commit("alpha");
    fireEvent.click(screen.getByLabelText("Match case"));
    await commit("beta");
    // Back to the panel's default before recalling, so a restored `case: true`
    // can only have come out of the history.
    fireEvent.click(screen.getByLabelText("Match case"));
    await waitFor(() => expect(lastSearch().options.case).toBe(false));

    // Both halves inside the wait: "beta" is already the query on screen, so
    // waiting only on the text would pass before the recalled search ran and
    // read the toggle state the recall was meant to replace.
    fireEvent.keyDown(queryInput(), { key: "ArrowUp" });
    await waitFor(() => {
      expect(lastSearch().query).toBe("beta");
      expect(lastSearch().options.case).toBe(true);
    });
    expect(queryInput().value).toBe("beta");

    fireEvent.keyDown(queryInput(), { key: "ArrowUp" });
    await waitFor(() => {
      expect(lastSearch().query).toBe("alpha");
      expect(lastSearch().options.case).toBe(false);
    });
  });

  it("gives back what you were typing when you arrow past the newest entry", async () => {
    mount();
    await commit("alpha");
    fireEvent.input(queryInput(), { target: { value: "half-typed" } });

    fireEvent.keyDown(queryInput(), { key: "ArrowUp" });
    await waitFor(() => expect(queryInput().value).toBe("alpha"));
    fireEvent.keyDown(queryInput(), { key: "ArrowDown" });
    await waitFor(() => expect(queryInput().value).toBe("half-typed"));
  });

  it("records the query you stood behind, not every prefix on the way to it", async () => {
    // The box searches as you type. Recording each search would leave a history
    // of "n", "ne", "nee" that nobody can arrow through.
    mount();
    await type("needle");
    fireEvent.keyDown(queryInput(), { key: "ArrowUp" });
    await waitFor(() => expect(queryInput().value).toBe("needle"));

    const { historyFor, loadSearchHistory } = await import("../../utils/searchHistory");
    expect(historyFor(loadSearchHistory(), "/proj").map((h) => h.query)).toEqual([]);
  });

  it("leaves the previous project's recall behind when the root changes", async () => {
    // The cursor indexes the history that was on screen, and the draft it would
    // restore is a query for the project you just left. Carried over, the first
    // arrow press in the new project types someone else's half-finished text.
    localStorage.setItem(
      "sway.searchHistory",
      JSON.stringify({ "/other": [{ query: "elsewhere" }] }),
    );
    const [root, setRoot] = createSignal<string | null>("/proj");
    render(() => <SearchPanel root={root()} focusNonce={0} />);

    await commit("here");
    fireEvent.input(queryInput(), { target: { value: "half-typed" } });
    fireEvent.keyDown(queryInput(), { key: "ArrowUp" });
    await waitFor(() => expect(queryInput().value).toBe("here"));

    setRoot("/other");
    await waitFor(() => expect(bridge.calls.some((c) => c.query === "")).toBe(true));
    // Down would walk back to the draft if the cursor had come along; here it
    // has nowhere to go, because recall starts over in a new project.
    fireEvent.keyDown(queryInput(), { key: "ArrowDown" });
    expect(queryInput().value).not.toBe("half-typed");
  });

  it("keeps each workspace's history to itself", async () => {
    const r = mount();
    await commit("here");
    r.unmount();

    mount({ root: "/other" });
    await waitFor(() => expect(bridge.calls.length).toBeGreaterThan(0));
    fireEvent.keyDown(queryInput(), { key: "ArrowUp" });
    // Nothing has been searched in this project, so Up has nowhere to go.
    expect(queryInput().value).toBe("");
  });
});

describe("saved searches", () => {
  /** Save the current query under `name`. */
  function saveAs(name: string) {
    fireEvent.input(screen.getByLabelText("Name this search"), { target: { value: name } });
    fireEvent.click(screen.getByText("Save"));
  }

  it("survives a relaunch, with the query and toggles it was saved with", async () => {
    const r = mount();
    await type("needle");
    fireEvent.click(screen.getByLabelText("Use regular expression"));
    await waitFor(() => expect(lastSearch().options.regex).toBe(true));
    openSavedRow();
    saveAs("todos");
    await waitFor(() => expect(screen.getByText("todos")).toBeTruthy());
    r.unmount();

    // A fresh mount reads storage the way a fresh launch does.
    mount();
    openSavedRow();
    expect(screen.getByText("todos")).toBeTruthy();

    const { loadSavedSearches, savedFor } = await import("../../utils/savedSearches");
    expect(savedFor(loadSavedSearches(), "/proj")).toEqual([
      { name: "todos", query: "needle", options: expect.objectContaining({ regex: true }) },
    ]);
  });

  it("renames one without disturbing what it runs", async () => {
    mount();
    await type("needle");
    openSavedRow();
    saveAs("todos");
    await waitFor(() => expect(screen.getByText("todos")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Rename todos"));
    const box = screen.getByLabelText("New name for todos") as HTMLInputElement;
    fireEvent.keyDown(box, { key: "Enter", target: { value: "chores" } });

    await waitFor(() => expect(screen.getByText("chores")).toBeTruthy());
    const { loadSavedSearches, savedFor } = await import("../../utils/savedSearches");
    expect(savedFor(loadSavedSearches(), "/proj")[0].query).toBe("needle");
  });

  it("refuses a rename onto a name in use, and says so where it happened", async () => {
    // Not in the search-error slot: that is where an invalid regex reports, and
    // a naming complaint sitting above the hits reads as though the search
    // below it was the thing that failed.
    bridge.respond = () => ONE_FILE();
    mount();
    await type("ab");
    openSavedRow();
    saveAs("todos");
    await waitFor(() => expect(screen.getByText("todos")).toBeTruthy());
    saveAs("hooks");
    await waitFor(() => expect(screen.getByText("hooks")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Rename todos"));
    fireEvent.keyDown(screen.getByLabelText("New name for todos"), {
      key: "Enter",
      target: { value: "hooks" },
    });

    await waitFor(() => expect(screen.getByText(/already named "hooks"/)).toBeTruthy());
    // Both survive, and the results are still on screen underneath.
    expect(screen.getByText("todos")).toBeTruthy();
    expect(screen.getByText("hooks")).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
  });

  it("deletes one, and says so to storage", async () => {
    mount();
    await type("needle");
    openSavedRow();
    saveAs("todos");
    await waitFor(() => expect(screen.getByText("todos")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Delete todos"));
    await waitFor(() => expect(screen.queryByText("todos")).toBeNull());
    const { loadSavedSearches, savedFor } = await import("../../utils/savedSearches");
    expect(savedFor(loadSavedSearches(), "/proj")).toEqual([]);
  });

  it("opens as an editable results buffer, not just a list to click through", async () => {
    // The point of saving a search after Phase 11: opening one lands you on the
    // thing you can edit and write back, with the panel restored underneath so
    // the toggles on screen still describe what you are looking at.
    bridge.respond = () => ok([match("const needle = 1", [[6, 12]], 12, "src/a.ts")]);
    const r = mount();
    await type("needle");
    fireEvent.click(screen.getByLabelText("Use regular expression"));
    await waitFor(() => expect(lastSearch().options.regex).toBe(true));
    openSavedRow();
    saveAs("todos");
    await waitFor(() => expect(screen.getByText("todos")).toBeTruthy());
    r.unmount();

    mount();
    openSavedRow();
    const opened: string[] = [];
    const listener = (e: Event) => opened.push((e as CustomEvent).detail.path);
    window.addEventListener("sway:open-in-editor", listener);
    try {
      fireEvent.click(screen.getByText("todos"));
      await waitFor(() => expect(opened.length).toBe(1));
    } finally {
      window.removeEventListener("sway:open-in-editor", listener);
    }

    const { searchBuffer } = await import("./searchResultsStore");
    const buf = searchBuffer(opened[0])!;
    expect(buf.doc.query).toBe("needle");
    expect(buf.doc.rows).toContainEqual({
      kind: "match",
      file: "src/a.ts",
      line: 12,
      original: "const needle = 1",
    });
    // Restored, not merely run: the search it fired carries the saved toggles.
    expect(lastSearch().options.regex).toBe(true);
    expect(queryInput().value).toBe("needle");
  });

  it("opens no tab for a saved search that now matches nothing", async () => {
    // An empty results buffer is a tab to close, not an answer.
    bridge.respond = () => ok([match("const needle = 1", [[6, 12]], 12, "src/a.ts")]);
    mount();
    await type("needle");
    openSavedRow();
    saveAs("todos");
    await waitFor(() => expect(screen.getByText("todos")).toBeTruthy());

    bridge.respond = () => ok([]);
    const opened: string[] = [];
    const listener = (e: Event) => opened.push((e as CustomEvent).detail.path);
    window.addEventListener("sway:open-in-editor", listener);
    try {
      fireEvent.click(screen.getByText("todos"));
      await waitFor(() => expect(lastSearch().query).toBe("needle"));
      expect(opened.length).toBe(0);
    } finally {
      window.removeEventListener("sway:open-in-editor", listener);
    }
  });
});
