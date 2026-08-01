import { describe, it, expect, vi, beforeEach } from "vitest";
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

const bridge: {
  calls: Call[];
  respond: (query: string, options: Options) => unknown;
} = {
  calls: [],
  respond: () => ({ matches: [], truncated: false, backend: "rg", unsupported: [], files: [] }),
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
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

function mount() {
  return render(() => <SearchPanel root="/proj" focusNonce={0} />);
}

/** The searches the panel actually ran, ignoring the empty-query capability
 *  probe it fires on mount. */
const searches = () => bridge.calls.filter((c) => c.query !== "");

async function type(value: string) {
  const input = screen.getByPlaceholderText("Search project") as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
  await waitFor(() => expect(searches().length).toBeGreaterThan(0));
}

beforeEach(() => {
  bridge.calls = [];
  bridge.respond = () => ok([]);
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
