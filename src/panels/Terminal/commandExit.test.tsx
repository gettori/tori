import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { COMMAND_EXIT_OSC, parseCommandExit } from "./commandExit";

const write = (term: Terminal, data: string) => new Promise<void>((done) => term.write(data, done));

/** A terminal wired the way TerminalView wires one, recording what it accepts. */
function listening(nonce: string) {
  const term = new Terminal({ allowProposedApi: true });
  const codes: number[] = [];
  term.parser.registerOscHandler(COMMAND_EXIT_OSC, (payload) => {
    const code = parseCommandExit(payload, nonce);
    if (code === null) return false;
    codes.push(code);
    return true;
  });
  return { term, codes };
}

describe("parseCommandExit", () => {
  it("reads the code out of a report carrying this tab's nonce", () => {
    expect(parseCommandExit("abc;0", "abc")).toBe(0);
    expect(parseCommandExit("abc;130", "abc")).toBe(130);
  });

  it("refuses another nonce, a malformed code, and a report before the nonce is known", () => {
    expect(parseCommandExit("other;0", "abc")).toBeNull();
    expect(parseCommandExit("abc;", "abc")).toBeNull();
    expect(parseCommandExit("abc;-1", "abc")).toBeNull();
    expect(parseCommandExit("abc", "abc")).toBeNull();
    expect(parseCommandExit("abc;0", null)).toBeNull();
  });
});

describe("the report on the wire", () => {
  /// The reason the report is an OSC and not a sentinel line scanned in Rust:
  /// the PTY chunks bytes wherever it likes, and xterm's parser reassembles
  /// the sequence so a split never has to be handled by hand.
  it("fires once with the code when the sequence arrives split across two writes", async () => {
    const { term, codes } = listening("n1");
    const report = `\x1b]${COMMAND_EXIT_OSC};n1;3\x07`;
    await write(term, report.slice(0, 9));
    expect(codes).toEqual([]);
    await write(term, report.slice(9));
    expect(codes).toEqual([3]);
  });

  /// A login shell sources the user's rc, and VS Code (633) and iTerm2 /
  /// FinalTerm (133) integrations mark every prompt with an OSC. None of them
  /// may read as a verdict.
  it("ignores the prompt marks a shell integration emits", async () => {
    const { term, codes } = listening("n1");
    await write(term, "\x1b]133;A\x07\x1b]633;A\x07\x1b]633;D;0\x07prompt$ ");
    expect(codes).toEqual([]);
  });

  it("ignores a report carrying another run's nonce", async () => {
    const { term, codes } = listening("n1");
    await write(term, `\x1b]${COMMAND_EXIT_OSC};n2;0\x07`);
    expect(codes).toEqual([]);
  });
});
