import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { render, screen } from "../../test/harness";
import { invoke } from "@tauri-apps/api/core";
import CommitFiles from "./CommitFiles";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invoked = vi.mocked(invoke);

const detail = (paths: string[]) => ({
  files: paths.map((path) => ({ path, old_path: null, status: "M" })),
});

describe("a commit's file rows", () => {
  beforeEach(() => invoked.mockReset());

  it("says it is reading until the commit's files land, then lists them", async () => {
    let land!: (value: unknown) => void;
    const read = new Promise((yes) => (land = yes));
    invoked.mockImplementation(async (command) => (command === "git_commit_detail" ? read : undefined));
    render(() => <CommitFiles root="/repo" sha="abc" />);
    expect(await screen.findByText("Reading the files...")).toBeTruthy();

    land(detail(["src/a.ts"]));
    expect(await screen.findByText("a.ts")).toBeTruthy();
    expect(screen.queryByText("Reading the files...")).toBeNull();
  });

  it("says a commit with no files has none", async () => {
    invoked.mockImplementation(async (command) => (command === "git_commit_detail" ? detail([]) : undefined));
    render(() => <CommitFiles root="/repo" sha="abc" />);
    expect(await screen.findByText("No files in this commit.")).toBeTruthy();
  });

  it("shows the reason when the commit cannot be read", async () => {
    invoked.mockImplementation(async (command) => {
      if (command === "git_commit_detail") throw "bad object abc";
    });
    render(() => <CommitFiles root="/repo" sha="abc" />);
    expect(await screen.findByText("bad object abc")).toBeTruthy();
    expect(screen.queryByText("No files in this commit.")).toBeNull();
  });
});
