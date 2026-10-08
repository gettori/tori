import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen, cleanup } from "@solidjs/testing-library";
import type { Claim, ClaimRange } from "../../utils/provenance";

let answer: ClaimRange[] = [];
let asked: Record<string, unknown>[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd !== "diff_provenance") return Promise.resolve(null);
    asked.push(args);
    return Promise.resolve([answer]);
  },
}));

const { default: HunkProvenance } = await import("./HunkProvenance");

const HUNK = {
  header: "@@ -1,2 +1,3 @@",
  startLine: 1,
  endLine: 3,
  oldStart: 1,
  lines: [" one", "+two", " three"],
};

const SESSION = { id: "sess-1", agent: "claude", title: "fix the parser" };
const TURN = { session: SESSION, ordinal: 4, promptTs: 1_800_000_000, prompt: "add line two" };
const EDIT = {
  toolUseId: "toolu_1",
  name: "Edit",
  kind: "edit",
  namesFile: true,
  input: { file_path: "/repo/src/a.ts" },
  reply: "Adding the second line.",
};
const SHELL = { ...EDIT, toolUseId: "toolu_2", name: "Bash", kind: "execute", input: { command: "echo two >> a.ts" } };

function show(claim: Claim) {
  answer = [{ start: 2, count: 1, claim }];
  render(() => <HunkProvenance root="/repo" file="src/a.ts" hunk={HUNK} staged={false} />);
}

beforeEach(() => {
  cleanup();
  answer = [];
  asked = [];
});

describe("what the panel says about a hunk", () => {
  it("names the one call that wrote it, with the words before it", async () => {
    show({ tier: "call", turn: TURN, call: EDIT });

    expect(await screen.findByText("Written by Edit in turn 4 of fix the parser.")).toBeTruthy();
    expect(screen.getByText("Adding the second line.")).toBeTruthy();
    expect(screen.getByText("Edit /repo/src/a.ts")).toBeTruthy();
    expect(screen.getByText("add line two")).toBeTruthy();
    expect(asked[0]).toEqual({
      projectPath: "/repo",
      file: "src/a.ts",
      hunks: ["@@ -1,2 +1,3 @@\n one\n+two\n three"],
      staged: false,
    });
  });

  it("lists the candidates and says the record does not pick", async () => {
    show({ tier: "candidates", turn: TURN, calls: [EDIT, { ...EDIT, toolUseId: "toolu_3" }] });

    expect(
      await screen.findByText("Written in turn 4 of fix the parser by one of 2 calls. The record does not say which."),
    ).toBeTruthy();
  });

  it("names the shell command for a write no path parse could see", async () => {
    show({ tier: "shell", turn: TURN, calls: [SHELL] });

    expect(await screen.findByText("Written by a shell command in turn 4 of fix the parser.")).toBeTruthy();
    expect(screen.getByText("Bash echo two >> a.ts")).toBeTruthy();
  });

  it("says why nobody is named, and names no turn", async () => {
    show({
      tier: "none",
      reason: "overlapping",
      sessions: [SESSION, { ...SESSION, id: "sess-2", title: "write tests" }],
    });

    expect(
      await screen.findByText(
        "fix the parser and write tests were each in a turn that could have written this, so Tori names none of them.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/turn 4/)).toBeNull();
  });
});
