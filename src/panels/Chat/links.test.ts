import { describe, it, expect } from "vite-plus/test";
import { linkTarget } from "./links";

const CWD = "/Users/skarif/Projects/personal/adlc";

describe("where a link in assistant prose goes", () => {
  it("sends a real URL out of the app", () => {
    expect(linkTarget("https://example.com/x", CWD)).toEqual({ kind: "external", url: "https://example.com/x" });
    expect(linkTarget("http://localhost:5173", CWD)).toEqual({ kind: "external", url: "http://localhost:5173" });
    expect(linkTarget("mailto:a@b.c", CWD)).toEqual({ kind: "external", url: "mailto:a@b.c" });
  });

  // The exact link that used to take the app off the SPA: a model saying
  // "Created temp.md" writes it relative to where it is working.
  it("resolves a bare relative path against the session's cwd", () => {
    expect(linkTarget("temp.md", CWD)).toEqual({ kind: "file", path: `${CWD}/temp.md`, line: undefined });
    expect(linkTarget("./src/a.ts", CWD)).toEqual({ kind: "file", path: `${CWD}/src/a.ts`, line: undefined });
  });

  it("takes an absolute path as written", () => {
    expect(linkTarget(`${CWD}/sample.rs`, CWD)).toEqual({
      kind: "file",
      path: `${CWD}/sample.rs`,
      line: undefined,
    });
  });

  it("reads a trailing line number", () => {
    expect(linkTarget("src/a.ts:42", CWD)).toEqual({ kind: "file", path: `${CWD}/src/a.ts`, line: 42 });
  });

  it("resolves `..` rather than refusing it", () => {
    expect(linkTarget("../other/a.ts", CWD)).toMatchObject({ kind: "outside" });
    expect(linkTarget("src/../a.ts", CWD)).toEqual({ kind: "file", path: `${CWD}/a.ts`, line: undefined });
  });

  // Same rule the tool card's paths follow: a file outside the workspace is a
  // real case, and saying so beats opening a tab on something unexpected.
  it("reports a path outside the workspace rather than opening it", () => {
    expect(linkTarget("/etc/hosts", CWD)).toEqual({ kind: "outside", path: "/etc/hosts" });
  });

  it("undoes marked's percent-encoding", () => {
    expect(linkTarget("my%20notes.md", CWD)).toEqual({ kind: "file", path: `${CWD}/my notes.md`, line: undefined });
  });

  it("strips a file: scheme", () => {
    expect(linkTarget(`file://${CWD}/a.ts`, CWD)).toEqual({ kind: "file", path: `${CWD}/a.ts`, line: undefined });
  });

  it("ignores what it cannot place, so nothing is opened on a guess", () => {
    expect(linkTarget("", CWD)).toEqual({ kind: "ignore" });
    expect(linkTarget("   ", CWD)).toEqual({ kind: "ignore" });
    expect(linkTarget("#section", CWD)).toEqual({ kind: "ignore" });
    // No workspace to resolve against is not the same as a path at the root.
    expect(linkTarget("temp.md", "")).toEqual({ kind: "ignore" });
  });

  it("takes a Tori place to the navigator, cwd or not", () => {
    expect(linkTarget("tori://open?folder=/r/Initech%20News/app/my%20wt&session=s-1", CWD)).toEqual({
      kind: "navigate",
      target: { folder: "/r/Initech News/app/my wt", session: "s-1" },
    });
    expect(linkTarget("tori://open?folder=/r/personal/tori", "")).toEqual({
      kind: "navigate",
      target: { folder: "/r/personal/tori", session: undefined },
    });
  });

  it("ignores a Tori link it cannot place", () => {
    expect(linkTarget("tori://open?folder=relative/path", CWD)).toEqual({ kind: "ignore" });
    expect(linkTarget("tori://open?", CWD)).toEqual({ kind: "ignore" });
    expect(linkTarget("tori://settings", CWD).kind).not.toBe("navigate");
  });
});
