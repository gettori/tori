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
    input: { command: "ls -la" },
    output: null,
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
});
