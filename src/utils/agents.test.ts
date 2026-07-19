import { describe, it, expect } from "vitest";
import { resumeCommand, applyTemplate, type Agent } from "./agents";

const agent = (program: string, resume_args: string[]): Agent => ({
  id: "x",
  label: "X",
  program,
  base_args: [],
  yolo_args: [],
  resume_args,
  parser_kind: "claude_jsonl",
  running_pattern: "",
  pty_quiet_ms: 0,
});

describe("resumeCommand", () => {
  it("fills {id} against the launch binary", () => {
    expect(resumeCommand(agent("claude", ["--resume", "{id}"]), { id: "abc123", file: "/s/abc123.jsonl" })).toBe(
      "claude --resume abc123",
    );
  });

  it("fills {file} for a file-addressed adapter", () => {
    expect(resumeCommand(agent("pi", ["--session", "{file}"]), { id: "abc", file: "/s/abc.jsonl" })).toBe(
      "pi --session /s/abc.jsonl",
    );
  });

  it("quotes a path with a space, so the pasted command survives shell re-parsing", () => {
    expect(resumeCommand(agent("pi", ["--session", "{file}"]), { id: "a", file: "/My Docs/a.jsonl" })).toBe(
      "pi --session '/My Docs/a.jsonl'",
    );
  });

  it("quotes an embedded single quote", () => {
    expect(resumeCommand(agent("pi", ["--session", "{file}"]), { id: "a", file: "/it's/a.jsonl" })).toBe(
      `pi --session '/it'\\''s/a.jsonl'`,
    );
  });

  it("is null for a resume-less adapter", () => {
    expect(resumeCommand(agent("bare", []), { id: "a", file: "/s/a.jsonl" })).toBeNull();
  });
});

describe("applyTemplate", () => {
  it("substitutes both placeholders", () => {
    expect(applyTemplate(["-r", "{id}", "-f", "{file}"], { id: "1", file: "/f" })).toEqual(["-r", "1", "-f", "/f"]);
  });
});
