import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { ToolInput, ToolOutput } from "./ToolBody";
import ToolCallCard from "./ToolCallCard";
import { onWith, OPEN_IN_EDITOR, type OpenInEditor } from "../../utils/events";
import { BODY_ROWS } from "./toolOutput";
import type { ToolItem } from "./chatStore";

// Highlighting is asynchronous and lands in place; every assertion here is
// about what a body is made of, not what colour it ends up. Stubbed so no test
// pulls shiki into jsdom.
vi.mock("./highlight", () => ({ cappedHtml: vi.fn(() => null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

// Real, but countable: one of the tests below is about how often the output is
// parsed, not about what the parse says.
vi.mock("./toolOutput", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./toolOutput")>();
  return { ...actual, hitRows: vi.fn(actual.hitRows) };
});

const ESC = "\u001B";

function card(over: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: "tool",
    id: "tool-1",
    turnId: "t1",
    toolUseId: "toolu_1",
    name: "Bash",
    title: null,
    toolKind: "execute",
    locations: [],
    input: { command: "ls -la" },
    output: null,
    outputTruncated: false,
    summary: null,
    state: "ok",
    durationMs: 120,
    approval: null,
    edits: [],
    files: [],
    ...over,
  };
}

const read = (over: Partial<ToolItem> = {}) =>
  card({
    name: "Read",
    toolKind: "read",
    input: { file_path: "/repo/a.rs" },
    summary: { type: "read", lines: 2, from: 1, total: 9 },
    ...over,
  });

function renderCard(item: ToolItem) {
  return render(() => (
    <ToolCallCard
      card={item}
      sessionId="s1"
      cwd="/repo"
      onAnswer={() => {}}
      onSetMode={() => {}}
      onRevertHunk={async () => false}
    />
  ));
}

function mountCard(item: ToolItem) {
  const rendered = renderCard(item);
  fireEvent.click(rendered.container.querySelector("button") as HTMLButtonElement);
  return rendered;
}

describe("an execute body", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the command as a command, under a prompt the grammar never sees", () => {
    const { container } = render(() => <ToolInput card={card()} renderer="execute" />);
    expect(container.textContent).toBe("$ ls -la");
    // The command is a block of source; the prompt is the card talking.
    expect(container.querySelector("code")?.textContent).toBe("ls -la");
  });

  it("obeys none of the escapes a program wrote for a terminal that is not here", () => {
    const { container } = render(() => (
      <ToolOutput card={card()} renderer="execute" text={`${ESC}[31mboom${ESC}[0m\n`} onOpen={() => {}} />
    ));
    expect(container.textContent).toBe("boom\n");
    // Terminal output, not source: nothing here is handed to a grammar.
    expect(container.querySelector("code")).toBeNull();
  });

  // opencode answers an execute call with its whole `rawOutput` object, which
  // arrives as one line of JSON.
  it("opens an ACP raw output up rather than rendering the blob as a terminal", () => {
    const raw = '{"output":"hi\\n","metadata":{"exit":1,"truncated":false}}';
    const { container } = render(() => (
      <ToolOutput card={card()} renderer="execute" text={raw} onOpen={() => {}} />
    ));
    expect(container.textContent).not.toBe(raw);
    expect(container.textContent?.split("\n").length).toBeGreaterThan(4);
    expect(container.querySelector("code")).toBeTruthy();
  });
});

describe("what a closed card costs", () => {
  beforeEach(() => vi.clearAllMocks());

  // Every memo that could paint a body lives in the body, and a body only
  // exists while the card is open. A transcript of sixty collapsed calls is
  // sixty cards and no highlighting at all.
  it("highlights nothing until someone opens the card", async () => {
    const { cappedHtml } = await import("./highlight");
    const { container } = renderCard(card({ output: "ls: no such file" }));
    expect(vi.mocked(cappedHtml)).not.toHaveBeenCalled();

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(vi.mocked(cappedHtml)).toHaveBeenCalled();
  });
});

describe("a read body", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens the file at the line whose gutter was clicked", () => {
    const seen: OpenInEditor[] = [];
    const off = onWith<OpenInEditor>(OPEN_IN_EDITOR, (d) => seen.push(d));
    const { getByRole } = mountCard(read({ output: "     1\tfirst\n     2\tsecond\n" }));
    fireEvent.click(getByRole("button", { name: "Open at line 2" }));
    off();
    expect(seen).toEqual([{ path: "/repo/a.rs", line: 2 }]);
  });

  // Only the first tab belongs to the gutter. A file whose own content is tab
  // separated must come back whole.
  it("renders a file whose own content has leading digits and tabs unmangled", () => {
    const { container } = mountCard(read({ output: "     1\t12\thello\n     2\t99\tworld\n" }));
    expect(container.textContent).toContain("12\thello");
    expect(container.textContent).toContain("99\tworld");
  });

  it("numbers a file that arrived with no gutter from where the summary says", () => {
    const { getByRole } = mountCard(
      read({ output: "fn main() {\n}\n", summary: { type: "read", lines: 2, from: 20, total: 40 } }),
    );
    expect(getByRole("button", { name: "Open at line 21" })).toBeTruthy();
  });
});

describe("a list body", () => {
  beforeEach(() => vi.clearAllMocks());

  // A `Grep` can answer with thousands, and a transcript is not a results pane.
  it("renders the cap for a 5000-hit result, and the rest on request", () => {
    const hits = Array.from({ length: 5000 }, (_, i) => `src/a.rs:${i + 1}:hit`).join("\n");
    const { container, getByText } = render(() => (
      <ToolOutput card={card({ toolKind: "search" })} renderer="search" text={hits} onOpen={() => {}} />
    ));
    expect(container.querySelectorAll("button")).toHaveLength(BODY_ROWS + 1);

    fireEvent.click(getByText("Show all 5000 rows"));
    expect(container.querySelectorAll("button")).toHaveLength(5000);
  });

  // The rows come off a props getter that parses the whole output, and the body
  // reads it more than once per pass.
  it("parses the output once per change rather than once per read", async () => {
    const { hitRows } = await import("./toolOutput");
    render(() => (
      <ToolOutput card={card({ toolKind: "search" })} renderer="search" text={"src/a.rs:1:hit\n"} onOpen={() => {}} />
    ));
    expect(vi.mocked(hitRows)).toHaveBeenCalledTimes(1);
  });

  it("offers nothing more to show when everything fitted", () => {
    const { container, queryByText } = render(() => (
      <ToolOutput card={card({ toolKind: "search" })} renderer="paths" text={"/a.rs\n/b.rs\n"} onOpen={() => {}} />
    ));
    expect(container.querySelectorAll("button")).toHaveLength(2);
    expect(queryByText(/^Show all/)).toBeNull();
  });

  it("opens the file a path row names", () => {
    const opened: [string, number | undefined][] = [];
    const { getByText } = render(() => (
      <ToolOutput
        card={card({ toolKind: "search" })}
        renderer="paths"
        text={"/a.rs\n/b.rs\n"}
        onOpen={(p, l) => opened.push([p, l])}
      />
    ));
    fireEvent.click(getByText("/b.rs"));
    expect(opened).toEqual([["/b.rs", undefined]]);
  });

  it("opens a hit at the line it was found on", () => {
    const opened: [string, number | undefined][] = [];
    const { getByText } = render(() => (
      <ToolOutput
        card={card({ toolKind: "search" })}
        renderer="search"
        text={"src/a.rs:12:  fn main() {\n"}
        onOpen={(p, l) => opened.push([p, l])}
      />
    ));
    fireEvent.click(getByText("src/a.rs:12"));
    expect(opened).toEqual([["src/a.rs", 12]]);
  });
});
