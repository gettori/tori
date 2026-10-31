import { describe, it, expect } from "vite-plus/test";
import { toriCall } from "./toriTool";

describe("toriCall", () => {
  it("reads Claude's mcp__tori__ name", () => {
    expect(toriCall({ name: "mcp__tori__worktree_new", title: null, input: { branch: "fix-a" } })).toEqual({
      tool: "worktree_new",
      args: { branch: "fix-a" },
    });
  });

  // As codex-acp sends it: the kind token for a name, the tool in the title,
  // and the arguments wrapped.
  it("reads an ACP agent's wrapped call", () => {
    const card = {
      name: "execute",
      title: "mcp.tori.worktree_new",
      input: { server: "tori", tool: "worktree_new", arguments: { branch: "fix-a" } },
    };
    expect(toriCall(card)).toEqual({ tool: "worktree_new", args: { branch: "fix-a" } });
  });

  it("is null for another server's tool or a plain one", () => {
    expect(toriCall({ name: "mcp__linear__create_issue", title: null, input: {} })).toBeNull();
    expect(
      toriCall({ name: "execute", title: "mcp.linear.create_issue", input: { server: "linear", tool: "x" } }),
    ).toBeNull();
    expect(toriCall({ name: "Bash", title: null, input: { command: "ls" } })).toBeNull();
  });
});
