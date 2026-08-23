import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import ToolCallCard from "./ToolCallCard";
import type { ToolItem } from "./chatStore";

// The card reaches for Tauri when it expands an edit, which a jsdom test has
// none of. Stubbed to nothing: what is under test here is that the card renders
// what it was given, not what the backend returns.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

// No cast: a `as ToolItem` here would let a fixture omit a field the store
// always sets, and the card would then throw on something that cannot happen in
// the app. Same reason Phase 1's TypeScript mirror is compared rather than cast.
function card(over: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: "tool",
    id: "tool-1",
    turnId: "t1",
    toolUseId: "toolu_1",
    name: "Bash",
    title: null,
    input: { command: "ls -la" },
    output: null,
    outputTruncated: false,
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
  // or a future release can name a tool we have never heard of, and a card that
  // threw would take the whole transcript down with it.
  it("renders an unknown tool without throwing, collapsed and expanded", () => {
    const unknown = card({ name: "SomeFuturePluginTool", input: { whatever: [1, 2, 3] } });
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
});
