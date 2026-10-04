import { describe, expect, it, vi } from "vitest";
import { prWatchMenu, type PrWatchRow } from "./prWatchMenu";

const URL = "https://github.com/o/r/pull/7";
const label = (item: unknown) => (item as { label: string }).label;

describe("the PR row's watch items", () => {
  it("with no chat in the worktree, says why it cannot watch", () => {
    const [only] = prWatchMenu([], [], URL, { watch: vi.fn(), unwatch: vi.fn() });
    expect(only).toMatchObject({ label: "Watch with this session", refusing: true, note: "No chat is open in this worktree" });
  });

  it("with one chat, watches with this session, then offers to stop", () => {
    const watch = vi.fn();
    const chats = [{ sessionId: "s1", name: "fix login" }];
    const [item] = prWatchMenu(chats, [], URL, { watch, unwatch: vi.fn() });
    expect(label(item)).toBe("Watch with this session");
    (item as { onClick: () => void }).onClick();
    expect(watch).toHaveBeenCalledWith("s1");
    const watched: PrWatchRow[] = [{ session: "s1", url: URL, project: "/p", branch: "fix" }];
    expect(label(prWatchMenu(chats, watched, URL, { watch, unwatch: vi.fn() })[0])).toBe("Stop watching with this session");
  });

  it("with two chats, names each and marks only the one watching", () => {
    const chats = [
      { sessionId: "s1", name: "fix login" },
      { sessionId: "s2", name: "write tests" },
    ];
    const watched: PrWatchRow[] = [{ session: "s2", url: URL, project: "/p", branch: "fix" }];
    const items = prWatchMenu(chats, watched, URL, { watch: vi.fn(), unwatch: vi.fn() });
    expect(items.map(label)).toEqual(["Watch with fix login", "Stop watching with write tests"]);
  });
});
