import { beforeEach, describe, expect, it } from "vitest";
import { commandStatus, dropCommandStatus, reportCommandExit, resetCommandStatus } from "./commandStatus";
import type { OpenTerm } from "./terminalTabStore";

const tab = (id: string): OpenTerm => ({
  id,
  title: id,
  cwd: "/tmp",
  workspace: "shells:",
  kind: "command",
  program: "git",
  args: [],
  profile: null,
});

describe("commandStatus", () => {
  beforeEach(resetCommandStatus);

  it("reads running until a report lands, then the verdict the code says", () => {
    expect(commandStatus("install:claude")).toBe("running");
    expect(reportCommandExit("install:claude", 0)).toBe(true);
    expect(commandStatus("install:claude")).toBe("ok");
    expect(reportCommandExit("clone:x", 130)).toBe(true);
    expect(commandStatus("clone:x")).toBe("failed");
  });

  /// A tab exits once, so a second report under its id is stale. Letting it
  /// through would re-toast, and here it would flip a verdict.
  it("keeps the first report and refuses a second", () => {
    expect(reportCommandExit("signin:claude:work", 3)).toBe(true);
    expect(reportCommandExit("signin:claude:work", 0)).toBe(false);
    expect(commandStatus("signin:claude:work")).toBe("failed");
  });

  /// The store is the whole point: recording a verdict must not touch the tab
  /// object the strip keys by, or the surface remounts as the output lands.
  it("records a verdict without touching the tab object", () => {
    const t = tab("install:claude");
    const before = JSON.stringify(t);
    reportCommandExit(t.id, 2);
    expect(JSON.stringify(t)).toBe(before);
    expect(commandStatus(t.id)).toBe("failed");
  });

  /// Dedupe mints ids from what they act on (`install:claude`), so a closed
  /// tab's verdict would otherwise greet the next install under that id.
  it("drops a closed tab's entry so the id can report again", () => {
    reportCommandExit("install:claude", 1);
    dropCommandStatus("install:claude");
    expect(commandStatus("install:claude")).toBe("running");
    expect(reportCommandExit("install:claude", 0)).toBe(true);
    expect(commandStatus("install:claude")).toBe("ok");
    dropCommandStatus("never-reported");
  });
});
