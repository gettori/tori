import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { setDiagnostics } from "@codemirror/lint";
import {
  capDiagnostics,
  diagnostics,
  dropDiagnostics,
  fixesFor,
  setDiagnosticFixLookup,
  MAX_PER_FILE,
  orderFiles,
  publishDiagnostics,
  severityRank,
  summarize,
  type Problem,
  type Severity,
} from "./diagnostics";
// Moved out of the store so the store stays free of runtime CodeMirror imports
// (see panels/Editor/problemsFromState.ts).
import { problemsFromState } from "../panels/Editor/problemsFromState";

const p = (line: number, severity: Severity, message = "m"): Problem => ({ line, endLine: line, column: 1, severity, message });

describe("severityRank", () => {
  it("orders error before warning before info before hint", () => {
    const ranks = (["error", "warning", "info", "hint"] as Severity[]).map(severityRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(4);
  });
});

describe("capDiagnostics", () => {
  it("leaves a list under the cap untouched", () => {
    const list = [p(1, "warning"), p(2, "error")];
    expect(capDiagnostics(list, 10)).toEqual(list);
  });

  it("keeps errors when truncating a flood of warnings", () => {
    // The case the cap exists for: a broken config produces hundreds of
    // warnings before the one error the user actually needs to see.
    const list = [...Array.from({ length: 300 }, (_, i) => p(i + 1, "warning")), p(999, "error")];
    const capped = capDiagnostics(list, 10);
    expect(capped).toHaveLength(10);
    expect(capped.some((d) => d.severity === "error")).toBe(true);
  });

  it("restores document order after truncating", () => {
    const list = [p(50, "warning"), p(10, "error"), p(30, "warning"), p(20, "error")];
    const capped = capDiagnostics(list, 3);
    expect(capped.map((d) => d.line)).toEqual([...capped.map((d) => d.line)].sort((a, b) => a - b));
  });

  it("breaks a line tie on column", () => {
    const list = [
      { line: 5, endLine: 5, column: 9, severity: "error" as Severity, message: "b" },
      { line: 5, endLine: 5, column: 2, severity: "error" as Severity, message: "a" },
      { line: 9, endLine: 9, column: 1, severity: "error" as Severity, message: "c" },
    ];
    expect(capDiagnostics(list, 2).map((d) => d.column)).toEqual([2, 9]);
  });
});

describe("summarize", () => {
  it("counts each severity and reports zeroes for the rest", () => {
    expect(summarize([p(1, "error"), p(2, "error"), p(3, "hint")])).toEqual({
      error: 2,
      warning: 0,
      info: 0,
      hint: 1,
    });
  });

  it("returns all zeroes for an empty list", () => {
    expect(summarize([])).toEqual({ error: 0, warning: 0, info: 0, hint: 0 });
  });
});

describe("orderFiles", () => {
  it("puts the file with the worst severity first", () => {
    const entries: [string, Problem[]][] = [
      ["b.ts", [p(1, "warning"), p(2, "warning"), p(3, "warning")]],
      ["a.ts", [p(1, "error")]],
    ];
    expect(orderFiles(entries).map(([f]) => f)).toEqual(["a.ts", "b.ts"]);
  });

  it("breaks a severity tie on count, then on path", () => {
    const entries: [string, Problem[]][] = [
      ["z.ts", [p(1, "error")]],
      ["a.ts", [p(1, "error")]],
      ["m.ts", [p(1, "error"), p(2, "error")]],
    ];
    expect(orderFiles(entries).map(([f]) => f)).toEqual(["m.ts", "a.ts", "z.ts"]);
  });

  it("does not mutate the input", () => {
    const entries: [string, Problem[]][] = [
      ["b.ts", [p(1, "warning")]],
      ["a.ts", [p(1, "error")]],
    ];
    const before = entries.map(([f]) => f);
    orderFiles(entries);
    expect(entries.map(([f]) => f)).toEqual(before);
  });
});

describe("problemsFromState (against real CodeMirror)", () => {
  const doc = "const a = 1;\nconst b = 2;\nconst c = 3;\n";

  const withDiagnostics = (ds: { from: number; to: number; severity: string; message: string }[]) => {
    let state = EditorState.create({ doc });
    // setDiagnostics self-installs the lint field, which is exactly how the LSP
    // client delivers them at runtime.
    state = state.update(setDiagnostics(state, ds as never)).state;
    return state;
  };

  it("converts a document offset to a 1-based line and column", () => {
    // Offset 13 is the first character of line 2.
    const problems = problemsFromState(withDiagnostics([{ from: 13, to: 18, severity: "error", message: "bad" }]));
    expect(problems).toEqual([{ line: 2, endLine: 2, column: 1, severity: "error", message: "bad" }]);
  });

  it("reports a mid-line column correctly", () => {
    // Offset 19 is 7 characters into line 2 ("const b" -> the 'b' is at 7).
    const problems = problemsFromState(withDiagnostics([{ from: 19, to: 20, severity: "warning", message: "hm" }]));
    expect(problems[0].line).toBe(2);
    expect(problems[0].column).toBe(7);
  });

  it("puts the very first character at line 1 column 1, not 0", () => {
    const problems = problemsFromState(withDiagnostics([{ from: 0, to: 5, severity: "error", message: "x" }]));
    expect(problems[0]).toMatchObject({ line: 1, column: 1 });
  });

  it("carries every severity through unchanged", () => {
    const problems = problemsFromState(
      withDiagnostics([
        { from: 0, to: 1, severity: "error", message: "e" },
        { from: 13, to: 14, severity: "warning", message: "w" },
        { from: 26, to: 27, severity: "info", message: "i" },
      ]),
    );
    expect(problems.map((p) => p.severity)).toEqual(["error", "warning", "info"]);
  });

  it("keeps the end line of a diagnostic that spans several", () => {
    // Offsets 5..20 straddle the first newline, so the mention must read
    // L1-L2 rather than collapsing to a single line.
    const problems = problemsFromState(withDiagnostics([{ from: 5, to: 20, severity: "error", message: "span" }]));
    expect(problems[0]).toMatchObject({ line: 1, endLine: 2 });
  });

  it("returns nothing for a buffer with no diagnostics", () => {
    expect(problemsFromState(EditorState.create({ doc }))).toEqual([]);
  });
});

describe("store round trip", () => {
  it("publishes, caps, and drops a file", () => {
    publishDiagnostics("/a.ts", [p(1, "error")]);
    expect(diagnostics()["/a.ts"]).toHaveLength(1);

    // An empty publish removes the file rather than leaving a zero count.
    publishDiagnostics("/a.ts", []);
    expect("/a.ts" in diagnostics()).toBe(false);

    publishDiagnostics("/b.ts", Array.from({ length: 500 }, (_, i) => p(i + 1, "warning")));
    expect(diagnostics()["/b.ts"].length).toBe(MAX_PER_FILE);

    dropDiagnostics("/b.ts");
    expect(diagnostics()).toEqual({});
  });
});

describe("the fix lookup the editor registers", () => {
  // Registered rather than imported: the Problems panel is on the eager side of
  // the lazy editor boundary, so it cannot reach the LSP client itself without
  // pulling CodeMirror into the startup chunk.
  const problem = p(12, "error", "Cannot find name 'foo'.");

  it("answers empty when no editor is mounted", async () => {
    // The honest answer: no client is running to ask.
    expect(await fixesFor("/a.ts", problem)).toEqual([]);
  });

  it("asks whoever registered, about whichever file it was given", async () => {
    // Any path, not only the one on screen. A problem in a background tab is
    // one of the main reasons to send one to an agent at all.
    const seen: string[] = [];
    const off = setDiagnosticFixLookup(async (path) => {
      seen.push(path);
      return ["Add import from './b'"];
    });

    expect(await fixesFor("/not-the-active-tab.ts", problem)).toEqual(["Add import from './b'"]);
    expect(seen).toEqual(["/not-the-active-tab.ts"]);
    off();
  });

  it("answers empty rather than rejecting when the lookup fails", async () => {
    // This runs on the way to composing a message for an agent: a server that
    // will not answer is a reason to send the diagnostic alone, not to send
    // nothing.
    const off = setDiagnosticFixLookup(() => Promise.reject(new Error("server died")));
    expect(await fixesFor("/a.ts", problem)).toEqual([]);
    off();
  });

  it("lets a later registration replace an earlier one, and does not let the old cleanup clear it", async () => {
    // Two editors never coexist, but a remount registers before the old one
    // cleans up, and an unguarded cleanup would leave the panel with nothing.
    const offFirst = setDiagnosticFixLookup(async () => ["first"]);
    const offSecond = setDiagnosticFixLookup(async () => ["second"]);

    offFirst();

    expect(await fixesFor("/a.ts", problem)).toEqual(["second"]);
    offSecond();
    expect(await fixesFor("/a.ts", problem)).toEqual([]);
  });
});
