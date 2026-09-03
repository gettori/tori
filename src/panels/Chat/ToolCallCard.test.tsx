import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createStore } from "solid-js/store";
import ToolCallCard from "./ToolCallCard";
import type { ToolItem } from "./chatStore";

// The card reaches for Tauri when it expands an edit, which a jsdom test has
// none of. Stubbed to nothing: what is under test here is that the card renders
// what it was given, not what the backend returns.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

// Highlighting is lazy, asynchronous, and lands in place; nothing here asserts
// colour. Stubbed so no card test pulls shiki into jsdom.
vi.mock("./highlight", () => ({
  cappedHtml: vi.fn(() => null),
  cappedLines: vi.fn(() => null),
  langOfPath: (p: string) => p.split(".").pop() ?? "",
}));

// No cast: a `as ToolItem` here would let a fixture omit a field the store
// always sets, and the card would then throw on something that cannot happen in
// the app. Same reason Phase 1's TypeScript mirror is compared rather than cast.
function card(over: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: "tool",
    id: "tool-1",
    turnId: "t1",
    toolUseId: "toolu_1",
    agentId: null,
    name: "Bash",
    title: null,
    toolKind: "execute",
    locations: [],
    input: { command: "ls -la" },
    output: null,
    outputTruncated: false,
    summary: null,
    patch: [],
    state: "ok",
    durationMs: 120,
    approval: null,
    edits: [],
    files: [],
    ...over,
  };
}

function mount(item: ToolItem, onSetMode: (mode: string) => void = () => {}) {
  return render(() => (
    <ToolCallCard
      card={item}
      sessionId="s1"
      cwd="/repo"
      onAnswer={() => {}}
      onSetMode={onSetMode}
      onRevertHunk={async () => false}
    />
  ));
}

/** A call blocked on the agent's own question, carrying the suggestions
 *  claude 2.1.231 was measured to send with one. */
function blocked(over: Partial<ToolItem> = {}): ToolItem {
  return card({
    state: "awaitingApproval",
    approval: {
      requestId: "req-1",
      autoDenyAtMs: null,
      agentId: null,
      suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "ls -la" }],
          behavior: "allow",
          destination: "localSettings",
        },
        { type: "setMode", mode: "acceptEdits", destination: "session" },
      ],
    },
    ...over,
  });
}

describe("ToolCallCard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders a known tool collapsed, with its distinguishing argument", () => {
    const { getByText, queryByText } = mount(card());
    expect(getByText("Bash")).toBeTruthy();
    expect(getByText("ls -la")).toBeTruthy();
    // A settled call already reads as done; the label would caption every row.
    expect(queryByText("Done")).toBeNull();
  });

  // The renderer table's fallback is the common case: a plugin, an MCP server
  // or a future release can name a tool we have never heard of, and an agent
  // can call it under a kind this build has never heard of either. A card that
  // threw would take the whole transcript down with it.
  it("renders an unknown tool without throwing, collapsed and expanded", () => {
    const unknown = card({ name: "SomeFuturePluginTool", toolKind: "other", input: { whatever: [1, 2, 3] } });
    const { getByText, container } = mount(unknown);
    expect(getByText("SomeFuturePluginTool")).toBeTruthy();
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(container.textContent).toContain("whatever");
  });

  it("renders a call with no name at all rather than blanking the row", () => {
    const { getByText } = mount(card({ name: null, input: {} }));
    expect(getByText("tool")).toBeTruthy();
  });

  // ACP splits what Claude keeps in one field: `name` became the kind's token
  // so a mono row has a token to show, and the agent's sentence moved to
  // `title`. Until the two get separate places to sit, the row shows the prose,
  // or an ACP card would have gone from "Read the file README.md" to "read".
  it("shows the agent's own words for a call rather than its kind token", () => {
    const { getByText } = mount(card({ name: "read", title: "Read the file README.md", input: {} }));
    expect(getByText("Read the file README.md")).toBeTruthy();
  });

  it("falls back to the name when the agent offered no words of its own", () => {
    const { getByText } = mount(card({ name: "Bash", title: null, input: {} }));
    expect(getByText("Bash")).toBeTruthy();
  });

  // The agent offered "stop asking about edits" alongside the question. That
  // is a one-click action issuing the real mode switch, not a third way to
  // answer this one call.
  it("turns a setMode suggestion into a one-click mode switch", () => {
    const switched: string[] = [];
    const { getByText } = mount(blocked(), (mode) => switched.push(mode));

    fireEvent.click(getByText("Switch to accepting edits"));

    expect(switched).toEqual(["acceptEdits"]);
  });

  // `addRules` and `addDirectories` are already what the scoped Allow buttons
  // send back, so rendering them again would be two controls for one outcome.
  it("does not render a second control for the rule the Allow buttons already send", () => {
    const { queryByText, getByText } = mount(blocked());
    expect(getByText("Allow for this session")).toBeTruthy();
    expect(queryByText(/addRules|localSettings/)).toBeNull();
  });

  // A prompt from the `PreToolUse` bridge carries no suggestions at all, and
  // must still render its ordinary answers.
  it("renders a prompt that came with no suggestions", () => {
    const { getByText, queryByText } = mount(
      blocked({ approval: { requestId: "req-2", autoDenyAtMs: null, agentId: null, suggestions: [] } }),
    );
    expect(getByText("Allow once")).toBeTruthy();
    expect(queryByText(/^Switch to/)).toBeNull();
  });

  // The prompt comes off the hook socket and the declaration off the child's
  // stdout, so the card is routinely blocked before anything has said what kind
  // of call it is. The arguments are all it has, and they are enough.
  it("asks about a command as a command, even before the declaration lands", () => {
    const { container } = mount(blocked({ toolKind: "other", name: "Bash" }));
    expect(container.textContent).toContain("Run ls -la in this workspace?");
    expect(container.textContent).not.toContain("Allow Bash on");
  });

  it("shows a blocked call as blocked, not as a spinner", () => {
    const { getByText } = mount(card({ state: "awaitingApproval" }));
    expect(getByText("Waiting for approval")).toBeTruthy();
  });

  // The control is the only sign a card is showing an extract, so it must not
  // appear on a card that is showing everything: an output that fitted looks
  // exactly as it did before this existed.
  it("offers nothing more to show when the output arrived whole", () => {
    const { getByRole, queryByText } = mount(card({ output: "two lines\nof output" }));
    fireEvent.click(getByRole("button", { name: /Bash/ }));
    expect(queryByText("Show full output")).toBeNull();
  });

  it("fetches the rest once per open, and only when asked", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue("the whole thing");
    const { getByRole, getByText, findByText } = mount(
      card({ output: "the extra", outputTruncated: true }),
    );

    const row = getByRole("button", { name: /Bash/ });
    fireEvent.click(row);
    // Opening alone fetches nothing: an output over the cap is large by
    // definition and a turn can make dozens of calls.
    expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "chat_tool_output")).toHaveLength(0);

    fireEvent.click(getByText("Show full output"));
    expect(await findByText("the whole thing")).toBeTruthy();
    const fetches = () => vi.mocked(invoke).mock.calls.filter((c) => c[0] === "chat_tool_output");
    expect(fetches()).toHaveLength(1);

    // Closing and reopening asks again rather than showing a body the backend
    // may have evicted since, and asking again is one more fetch, not two.
    fireEvent.click(row);
    fireEvent.click(row);
    expect(await findByText("Show full output")).toBeTruthy();
    expect(fetches()).toHaveLength(1);
  });

  // The cache is bounded, so a card can outlive its own output. Saying so beats
  // a button that does nothing.
  it("says so when the rest is no longer held", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockResolvedValue(null);
    const { getByRole, getByText, findByText } = mount(
      card({ output: "the extract", outputTruncated: true }),
    );
    fireEvent.click(getByRole("button", { name: /Bash/ }));
    fireEvent.click(getByText("Show full output"));
    expect(await findByText("The rest of this output is no longer held.")).toBeTruthy();
  });
  // A collapsed transcript that cannot be read without opening anything is the
  // problem this row is here to fix; a row with no summary has to look exactly
  // as it did before it existed.
  it("reports the result on the collapsed row, and says nothing without one", () => {
    const { getByText } = mount(card({ summary: { type: "execute", exitCode: 1, lines: 118 } }));
    expect(getByText("exit 1, 118 lines")).toBeTruthy();
    expect(mount(card({ summary: null })).container.textContent).not.toContain("lines");
  });
});

// "Show the plumbing when it breaks" is about a break that just happened.
// Replayed history is full of failures that were dealt with long ago, and a
// codex tab replays its whole conversation on every reload.
describe("the row a write gets", () => {
  beforeEach(() => vi.clearAllMocks());

  // A row is 80 characters wide and `/Users/me/Projects/...` is 40 of them
  // before the part anyone is reading.
  it("names the file relative to the workspace, and does not repeat it below", () => {
    const { container, queryAllByText } = mount(
      card({
        name: "Edit",
        toolKind: "edit",
        input: { file_path: "/repo/src/panels/Chat/MessageList.tsx", old_string: "a", new_string: "b" },
      }),
    );
    expect(container.textContent).toContain("src/panels/Chat/MessageList.tsx");
    expect(container.textContent).not.toContain("/repo/src/panels");
    // The path chip under the row would be the same path a second time.
    expect(queryAllByText("/repo/src/panels/Chat/MessageList.tsx")).toHaveLength(0);
  });

  it("leaves a path outside the workspace absolute", () => {
    const { container } = mount(
      card({ name: "Read", toolKind: "read", input: { file_path: "/etc/hosts" } }),
    );
    expect(container.textContent).toContain("/etc/hosts");
  });
});

describe("writes folded onto one card", () => {
  beforeEach(() => vi.clearAllMocks());

  const write = (i: number, added: number): ToolItem =>
    card({
      id: `tool-${i}`,
      toolUseId: `toolu_${i}`,
      name: "Edit",
      toolKind: "edit",
      input: { file_path: "/repo/a.rs", old_string: `was ${i}`, new_string: `is ${i}` },
      summary: { type: "edit", added, removed: 0 },
    });

  // One row for the group means the row's numbers have to be the group's, or it
  // reports a third of the change and reads as a bug.
  it("adds up what the whole group changed", () => {
    const { getByText } = render(() => (
      <ToolCallCard
        card={write(1, 1)}
        also={[write(2, 14), write(3, 6)]}
        sessionId="s1"
        cwd="/repo"
        onAnswer={() => {}}
        onSetMode={() => {}}
        onRevertHunk={async () => false}
      />
    ));
    // Two numbers, each with its own verdict and its own colour.
    expect(getByText("+21")).toBeTruthy();
    expect(getByText("-0")).toBeTruthy();
  });

  // Four folded calls used to draw four framed blocks, which is the thing
  // folding them onto one card was supposed to stop.
  it("draws the whole group in one block", () => {
    const { container } = render(() => (
      <ToolCallCard
        card={write(1, 1)}
        also={[write(2, 1), write(3, 1)]}
        sessionId="s1"
        cwd="/repo"
        onAnswer={() => {}}
        onSetMode={() => {}}
        onRevertHunk={async () => false}
      />
    ));
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(container.querySelectorAll("[class*=toolDiffRows]")).toHaveLength(1);
  });

  it("draws every folded call's change, in order", () => {
    const { container } = render(() => (
      <ToolCallCard
        card={write(1, 1)}
        also={[write(2, 1)]}
        sessionId="s1"
        cwd="/repo"
        onAnswer={() => {}}
        onSetMode={() => {}}
        onRevertHunk={async () => false}
      />
    ));
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(container.textContent).toContain("is 1");
    expect(container.textContent).toContain("is 2");
  });
});

describe("a call that failed", () => {
  beforeEach(() => vi.clearAllMocks());

  const failed = (i: number, over: Partial<ToolItem> = {}): ToolItem =>
    card({
      id: `tool-${i}`,
      toolUseId: `toolu_${i}`,
      name: "Edit",
      toolKind: "edit",
      input: { file_path: `/a${i}.rs` },
      state: "error",
      ...over,
    });

  async function diffFetches() {
    const { invoke } = await import("@tauri-apps/api/core");
    return vi.mocked(invoke).mock.calls.filter((c) => c[0] === "chat_tool_diff");
  }

  it("mounts a reopened session's historical failures collapsed, and reads no diffs", async () => {
    const containers = Array.from({ length: 10 }, (_, i) => mount(failed(i)).container);
    for (const c of containers) expect(c.querySelector('[aria-expanded="true"]')).toBeNull();
    expect(await diffFetches()).toHaveLength(0);
  });

  // The card draws its own diff from the call, which costs nothing. Comparing
  // against the file on disk is the one that shells out, and it is the question
  // only the revert control needs answered.
  it("reads no diff until the on-disk comparison is asked for", async () => {
    const { container, getByText } = mount(failed(0));
    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(await diffFetches()).toHaveLength(0);

    fireEvent.click(getByText("Compare with the file on disk"));
    expect(await diffFetches()).toHaveLength(1);
  });

  it("opens itself when this tab watched the call fail", () => {
    const [live, setLive] = createStore(failed(0, { state: "running" }));
    const { container } = mount(live);
    expect(container.querySelector('[aria-expanded="true"]')).toBeNull();
    setLive("state", "error");
    expect(container.querySelector('[aria-expanded="true"]')).toBeTruthy();
  });

  it("opens itself on a denial too, which is the other way a call fails", () => {
    const [live, setLive] = createStore(failed(0, { state: "awaitingApproval" }));
    const { container } = mount(live);
    setLive("state", "denied");
    expect(container.querySelector('[aria-expanded="true"]')).toBeTruthy();
  });

  // Opening is not asking: the card opened itself, and a diff is a `git diff`
  // per file that nobody requested.
  it("reads no diff for a card a failure opened", async () => {
    const [live, setLive] = createStore(failed(0, { state: "running" }));
    mount(live);
    setLive("state", "error");
    expect(await diffFetches()).toHaveLength(0);
  });
});
