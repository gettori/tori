import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { expectNoAxeViolations } from "../../test/axe";

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
type Call = { root: string; query: string; options: Options };

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
  respond: (query: string, options: Options, root: string) => unknown;
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
    const root = args.root as string;
    bridge.calls.push({ root, query, options });
    try {
      return Promise.resolve(bridge.respond(query, options, root));
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
    // The explanation used to be a `title`, which a disabled button still shows
    // on hover; a tooltip does not, because a disabled button fires no pointer
    // events at all. That is what `tooltipWhenDisabled` puts back, and this is
    // the assertion that it is actually switched on here: hover the surface
    // around the control and the reason appears.
    const surface = ignored().closest("[data-tooltip-hover-surface]");
    expect(surface).toBeTruthy();
    fireEvent.pointerEnter(surface!);
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toContain("no ignore rules"));

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

  it("keeps every toolbar control named after the tooltip sweep", async () => {
    mount();
    await waitFor(() => expect(bridge.calls.length).toBeGreaterThan(0));

    // The sweep moved eleven controls off `title`, and on this panel every one
    // of them already carried an `aria-label` - so the name must come from that
    // and not from the tooltip. Named explicitly rather than left to axe, which
    // reports a *missing* name and has nothing to say about a changed one.
    // ("Replace all" lives behind the replace row, which has its own tests.)
    for (const name of [
      "Match case",
      "Use regular expression",
      "Edit results in a buffer",
      "Saved searches",
      "Toggle replace",
      "Include and exclude globs",
    ]) {
      expect(screen.getByLabelText(name)).toBeTruthy();
    }
  });

  it("describes the query box rather than titling it", async () => {
    mount();
    await waitFor(() => expect(bridge.calls.length).toBeGreaterThan(0));

    // This one hint did not become a tooltip: a tooltip on a text box sits over
    // the results for as long as it has focus. A description is announced on
    // focus instead, which is more than the `title` did for a keyboard user.
    const box = screen.getByPlaceholderText("Search project");
    expect(box.getAttribute("title")).toBeNull();
    const hint = document.getElementById(box.getAttribute("aria-describedby")!);
    expect(hint?.textContent).toContain("Up and Down walk what you have searched here");
  });

  it("has no accessibility violations", async () => {
    const { container } = mount();
    await waitFor(() => expect(bridge.calls.length).toBeGreaterThan(0));

    await expectNoAxeViolations(container);
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

describe("inside a Feature", () => {
  it("files history and saved searches under the workspace key, not the root it searched", async () => {
    mount({ workspace: "feature:f1" });
    await commit("here");
    const { historyFor, loadSearchHistory } = await import("../../utils/searchHistory");
    expect(historyFor(loadSearchHistory(), "feature:f1").map((h) => h.query)).toEqual(["here"]);
    expect(historyFor(loadSearchHistory(), "/proj")).toEqual([]);
    const ran = searches();
    expect(ran[ran.length - 1]?.query).toBe("here");
  });
});

// A Feature searches every member at once. `grep_project` stays single-root, so
// what is asserted here is strictly the panel's own job: that it fans out once
// per member, keeps each member's answer (and each member's failure) in its own
// section, and never lets one member's state speak for another's.
describe("multi-root search", () => {
  const API = "/feat/api";
  const WEB = "/feat/web";
  const DOCS = "/feat/docs";

  const MEMBERS = [
    { path: API, repoPath: "/repos/api", label: "Payments API" },
    { path: WEB, repoPath: "/repos/web", label: "Web App" },
    { path: DOCS, repoPath: "/repos/docs", label: "Docs Site" },
  ];

  const missing = {
    label: "Worktree missing",
    usable: false,
    action: "recreate" as const,
    reason: null,
  };

  const mountFeature = (extra: Partial<Parameters<typeof SearchPanel>[0]> = {}) =>
    render(() => (
      <SearchPanel root={API} roots={MEMBERS} workspace="feature:f1" focusNonce={0} {...extra} />
    ));

  const sectionEl = (root: string) => document.querySelector(`[data-root="${root}"]`) as HTMLElement;
  const rootsSearched = () => searches().map((c) => c.root);

  it("greps every member once with the same options", async () => {
    mountFeature();
    await type("needle");

    expect(rootsSearched()).toEqual([API, WEB, DOCS]);
    const sent = searches().map((c) => JSON.stringify(c.options));
    expect(new Set(sent).size).toBe(1);
  });

  it("drops a fan-out that a newer search overtook", async () => {
    // The first query's legs never settle until the second has already been
    // sent, so the stale answer arrives last and must set nothing.
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => (release = r));
    bridge.respond = (query) =>
      query === "slow"
        ? held.then(() => ok([match("slow hit", [[0, 4]])]))
        : ok([match("fast hit", [[0, 4]])]);

    mountFeature();
    await type("slow");
    await type("fast");
    release!();

    const results = () => (document.querySelector(`[class*="results"]`) as HTMLElement).textContent ?? "";
    await waitFor(() => expect(results()).toContain("fast hit"));
    expect(results()).not.toContain("slow hit");
  });

  it("keeps the results when the active member changes", async () => {
    // `root` is the Feature's *active member*, the thing a Toolbar chip moves.
    // A search that spans every member must not be spent by that click.
    const [active, setActive] = createSignal(API);
    bridge.respond = () => ONE_FILE();
    render(() => (
      <SearchPanel root={active()} roots={MEMBERS} workspace="feature:f1" focusNonce={0} />
    ));
    await type("ab");
    await waitFor(() => expect(sectionEl(API).textContent).toContain("ab cd ab"));
    const ran = searches().length;

    setActive(WEB);
    await Promise.resolve();

    expect(sectionEl(API).textContent).toContain("ab cd ab");
    expect(searches().length).toBe(ran);
  });

  it("clears the results when the workspace itself changes", async () => {
    const [ws, setWs] = createSignal("feature:f1");
    bridge.respond = () => ONE_FILE();
    render(() => <SearchPanel root={API} roots={MEMBERS} workspace={ws()} focusNonce={0} />);
    await type("ab");
    await waitFor(() => expect(sectionEl(API).textContent).toContain("ab cd ab"));

    setWs("feature:f2");
    await waitFor(() => expect(sectionEl(API).textContent).not.toContain("ab cd ab"));
  });

  it("disables a toggle no member can honour and names that member's backend", async () => {
    bridge.respond = (_q, _o, root) =>
      root === WEB ? ok([], { backend: "plain", unsupported: ["noIgnore"] }) : ok([]);
    mountFeature();

    const ignored = () => screen.getByLabelText("Search ignored files") as HTMLButtonElement;
    await waitFor(() => expect(ignored().disabled).toBe(true));

    const surface = ignored().closest("[data-tooltip-hover-surface]");
    fireEvent.pointerEnter(surface!);
    // The reason belongs to the backend that blocked it, not to whichever root
    // happened to answer first.
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toContain("no ignore rules"));
  });

  it("skips a member with no usable worktree instead of grepping its repo", async () => {
    const roots = [MEMBERS[0], MEMBERS[1], { ...MEMBERS[2], state: missing }];
    render(() => (
      <SearchPanel root={API} roots={roots} workspace="feature:f1" focusNonce={0} />
    ));
    await type("needle");

    expect(rootsSearched()).toEqual([API, WEB]);
    expect(sectionEl(DOCS).textContent).toContain("Worktree missing");
  });

  it("draws one section per member, with its own chip", async () => {
    bridge.respond = () => ONE_FILE();
    const { container } = mountFeature();
    await type("ab");

    for (const m of MEMBERS) expect(sectionEl(m.path)).toBeTruthy();
    expect(sectionEl(API).textContent).toContain("PA");
    expect(sectionEl(WEB).textContent).toContain("WA");
    expect(sectionEl(DOCS).textContent).toContain("DS");

    await expectNoAxeViolations(container);
  });

  it("draws no section header for a lone root", async () => {
    bridge.respond = () => ONE_FILE();
    mount();
    await type("ab");

    expect(document.querySelector(`[data-root="/proj"]`)).toBeTruthy();
    expect(screen.queryByText("Payments API")).toBeNull();
    expect(document.querySelector(`[class*="sectionHeader"]`)).toBeNull();
  });

  it("reports truncation and failure per section, and keeps the rest", async () => {
    bridge.respond = (_q, _o, root) => {
      if (root === API) return ok([match("ab cd ab", [[0, 2], [6, 8]])], { truncated: true });
      if (root === WEB) throw new Error("grep: permission denied");
      return ok([match("docs hit", [[0, 4]], 3, "README.md")]);
    };
    mountFeature();
    await type("ab");

    await waitFor(() => expect(sectionEl(API).textContent).toContain("First 500 matching lines"));
    expect(sectionEl(WEB).textContent).toContain("permission denied");
    // The member that answered is untouched by the one that did not.
    expect(sectionEl(WEB).textContent).not.toContain("First 500");
    expect(sectionEl(DOCS).textContent).toContain("docs hit");
  });

  it("still errors at the panel level when every member fails", async () => {
    bridge.respond = () => {
      throw new Error("regex parse error");
    };
    mountFeature();
    await type("[");

    await waitFor(() => expect(screen.getByText(/regex parse error/)).toBeTruthy());
  });

  it("opens a hit against its own member's root", async () => {
    bridge.respond = (_q, _o, root) =>
      root === WEB ? ok([match("web hit", [[0, 3]], 12, "src/App.tsx")]) : ok([]);
    mountFeature();
    await type("web");

    await waitFor(() => expect(sectionEl(WEB).textContent).toContain("web hit"));

    const opened: { path: string; line?: number }[] = [];
    const listener = (e: Event) => opened.push((e as CustomEvent).detail);
    window.addEventListener("sway:open-in-editor", listener);
    try {
      fireEvent.click(sectionEl(WEB).querySelector(`[class*="matchRow"]`)!);
    } finally {
      window.removeEventListener("sway:open-in-editor", listener);
    }

    expect(opened).toEqual([{ path: `${WEB}/src/App.tsx`, line: 12 }]);
  });

  it("re-greps only the member a change happened under", async () => {
    bridge.respond = () => ONE_FILE();
    mountFeature();
    await type("ab");
    const before = searches().length;

    fsHandlers["fs://changed"]?.({ payload: { root: WEB } });
    await waitFor(() => expect(searches().length).toBe(before + 1));

    expect(searches()[searches().length - 1].root).toBe(WEB);
  });

  it("ignores a change under a folder that is not a member", async () => {
    bridge.respond = () => ONE_FILE();
    mountFeature();
    await type("ab");
    const before = searches().length;

    fsHandlers["fs://changed"]?.({ payload: { root: "/somewhere/else" } });
    await new Promise((r) => setTimeout(r, 500));

    expect(searches().length).toBe(before);
  });

  it("refuses the editable buffer while hits span more than one member", async () => {
    bridge.respond = (_q, _o, root) => (root === DOCS ? ok([]) : ONE_FILE());
    mountFeature();
    await type("ab");

    const open = () => screen.getByLabelText("Edit results in a buffer") as HTMLButtonElement;
    await waitFor(() => expect(open().disabled).toBe(true));

    // Refused out loud: the doc still holds one root, so a buffer over two would
    // write every row into the wrong repo.
    const surface = open().closest("[data-tooltip-hover-surface]");
    fireEvent.pointerEnter(surface!);
    await waitFor(() =>
      expect(screen.getByRole("tooltip").textContent).toContain("more than one member"),
    );
  });

  it("replaces against the member the row belongs to", async () => {
    // Both members hold the same relative path, which is the ordinary case in a
    // frontend/backend Feature and the one a bare path cannot tell apart.
    bridge.respond = (_q, _o, root) => (root === DOCS ? ok([]) : ONE_FILE("src/index.ts"));
    mountFeature();
    await type("ab");
    await typeReplacement("X");

    const webRow = sectionEl(WEB).querySelector(`[aria-label="Replace in src/index.ts"]`)!;
    fireEvent.click(webRow);

    await waitFor(() => expect(bridge.replaces.length).toBe(1));
    expect(bridge.replaces[0].root).toBe(WEB);
    expect(bridge.replaces[0].targets.map((t) => t.path)).toEqual(["src/index.ts"]);
  });

  it("replaces all across members, one call per member", async () => {
    bridge.respond = (_q, _o, root) => (root === DOCS ? ok([]) : ONE_FILE());
    mountFeature({ confirm: async () => true });
    await type("ab");
    await typeReplacement("X");

    fireEvent.click(screen.getByLabelText("Replace all"));

    await waitFor(() => expect(bridge.replaces.length).toBe(2));
    expect(bridge.replaces.map((r) => r.root)).toEqual([API, WEB]);
  });
});

// The search-local restriction (#156 phase 2). It narrows the grep and nothing
// else: the Toolbar's active-member row is a different control with a different
// meaning, and this one must not move it or be moved by it.
describe("member restriction", () => {
  const API = "/feat/api";
  const WEB = "/feat/web";
  const DOCS = "/feat/docs";
  const API_REPO = "/repos/api";
  const WEB_REPO = "/repos/web";

  const MEMBERS = [
    { path: API, repoPath: API_REPO, label: "Payments API" },
    { path: WEB, repoPath: WEB_REPO, label: "Web App" },
    { path: DOCS, repoPath: "/repos/docs", label: "Docs Site" },
  ];

  const mountFeature = (extra: Partial<Parameters<typeof SearchPanel>[0]> = {}) =>
    render(() => (
      <SearchPanel root={API} roots={MEMBERS} workspace="feature:f1" focusNonce={0} {...extra} />
    ));

  const chip = (label: string) => screen.getByLabelText(label) as HTMLButtonElement;
  const allChip = () => screen.getByText("All") as HTMLButtonElement;
  const pressed = (el: HTMLElement) => el.getAttribute("aria-pressed") === "true";
  const sectionEl = (root: string) => document.querySelector(`[data-root="${root}"]`);

  it("greps only the members it is narrowed to", async () => {
    mountFeature();
    await type("needle");
    const before = searches().length;
    expect(before).toBe(3);

    fireEvent.click(chip("Payments API"));

    await waitFor(() => expect(searches().length).toBeGreaterThan(before));
    expect(searches().slice(before).map((c) => c.root)).toEqual([API]);
  });

  it("is multi-select, and All puts every member back", async () => {
    mountFeature();
    await type("needle");

    fireEvent.click(chip("Payments API"));
    fireEvent.click(chip("Web App"));
    await waitFor(() => expect(pressed(chip("Web App"))).toBe(true));
    expect(pressed(chip("Payments API"))).toBe(true);
    expect(pressed(allChip())).toBe(false);

    const before = searches().length;
    fireEvent.click(allChip());
    await waitFor(() => expect(searches().length).toBeGreaterThan(before));
    expect(searches().slice(before).map((c) => c.root)).toEqual([API, WEB, DOCS]);
    expect(pressed(allChip())).toBe(true);
  });

  it("drops the sections of the members it excluded", async () => {
    // A bare header over no hits reads as "searched, nothing here", which is a
    // different answer from "not searched".
    bridge.respond = () => ONE_FILE();
    mountFeature();
    await type("ab");
    await waitFor(() => expect(sectionEl(WEB)).toBeTruthy());

    fireEvent.click(chip("Payments API"));

    await waitFor(() => expect(sectionEl(WEB)).toBeNull());
    expect(sectionEl(API)).toBeTruthy();
  });

  it("re-enables a toggle once the member that could not honour it is excluded", async () => {
    bridge.respond = (_q, _o, root) =>
      root === DOCS ? ok([], { backend: "plain", unsupported: ["noIgnore"] }) : ok([]);
    mountFeature();

    const ignored = () => screen.getByLabelText("Search ignored files") as HTMLButtonElement;
    await waitFor(() => expect(ignored().disabled).toBe(true));

    // Narrowed away from the `plain` member, the option is honourable again, so
    // leaving it greyed out would be disabling it on behalf of a repo this
    // search will not touch.
    fireEvent.click(chip("Payments API"));
    fireEvent.click(chip("Web App"));

    await waitFor(() => expect(ignored().disabled).toBe(false));
  });

  it("retires a replace outcome when the restriction changes", async () => {
    bridge.respond = (_q, _o, root) => (root === DOCS ? ok([]) : ONE_FILE());
    bridge.replaceResult = () => ({ changed: ["src/a.ts"], skipped: [], occurrences: 2 });
    mountFeature({ confirm: async () => true });
    await type("ab");
    await typeReplacement("X");

    fireEvent.click(screen.getByLabelText("Replace all"));
    await waitFor(() => expect(screen.getByText(/Replaced 4 occurrences/)).toBeTruthy());

    fireEvent.click(chip("Payments API"));

    // The line describes a replace across every member; over one member's hits
    // it is a claim about work that did not happen there.
    await waitFor(() => expect(screen.queryByText(/Replaced 4 occurrences/)).toBeNull());
  });

  it("restores the restriction a recalled query was run with", async () => {
    mountFeature();
    await type("needle");
    fireEvent.click(chip("Web App"));
    await waitFor(() => expect(pressed(chip("Web App"))).toBe(true));

    const input = screen.getByPlaceholderText("Search project");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(allChip());
    await waitFor(() => expect(pressed(chip("Web App"))).toBe(false));

    fireEvent.keyDown(input, { key: "ArrowUp" });

    // Recall hands back the search that was run, and which members it covered
    // is as much a part of that as the toggles are.
    await waitFor(() => expect(pressed(chip("Web App"))).toBe(true));
    expect(pressed(chip("Payments API"))).toBe(false);
  });

  it("re-runs a saved search against the members it was saved with", async () => {
    localStorage.setItem(
      "sway.savedSearches",
      JSON.stringify({
        "feature:f1": [
          { name: "web todos", query: "TODO", options: {}, repos: [WEB_REPO] },
        ],
      }),
    );
    mountFeature();
    fireEvent.click(screen.getByLabelText("Saved searches"));
    const before = searches().length;
    fireEvent.click(screen.getByText("web todos"));

    await waitFor(() => expect(searches().length).toBeGreaterThan(before));
    expect(searches().slice(before).map((c) => c.root)).toEqual([WEB]);
    expect(pressed(chip("Web App"))).toBe(true);
  });

  it("falls back to every member when the saved restriction names none of them", async () => {
    // A saved search whose members have all left should still answer. Searching
    // nothing for a query that used to work reads as broken, not as empty.
    localStorage.setItem(
      "sway.savedSearches",
      JSON.stringify({
        "feature:f1": [{ name: "gone", query: "TODO", options: {}, repos: ["/repos/vanished"] }],
      }),
    );
    mountFeature();
    fireEvent.click(screen.getByLabelText("Saved searches"));
    const before = searches().length;
    fireEvent.click(screen.getByText("gone"));

    await waitFor(() => expect(searches().length).toBeGreaterThan(before));
    expect(searches().slice(before).map((c) => c.root)).toEqual([API, WEB, DOCS]);
  });

  it("offers no chip for a member that cannot be searched", async () => {
    const missing = { label: "Worktree missing", usable: false, action: "recreate" as const, reason: null };
    render(() => (
      <SearchPanel
        root={API}
        roots={[MEMBERS[0], MEMBERS[1], { ...MEMBERS[2], state: missing }]}
        workspace="feature:f1"
        focusNonce={0}
      />
    ));

    await waitFor(() => expect(chip("Docs Site").disabled).toBe(true));
    expect(chip("Payments API").disabled).toBe(false);
  });

  it("has no chip row at all for a branch unit", async () => {
    mount();
    await waitFor(() => expect(bridge.calls.length).toBeGreaterThan(0));
    expect(screen.queryByRole("group", { name: "Search these members" })).toBeNull();
  });

  it("has no axe violations", async () => {
    bridge.respond = () => ONE_FILE();
    const { container } = mountFeature();
    await type("ab");
    fireEvent.click(chip("Payments API"));
    await waitFor(() => expect(pressed(chip("Payments API"))).toBe(true));

    await expectNoAxeViolations(container);
  });
});
