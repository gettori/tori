import type { MenuItem } from "../components/Menu/rows";

/** A live watch as Rust lists it. Mirrors `WatchRow` in src-tauri/src/rpc/mod.rs. */
export type PrWatchRow = { session: string; url: string; project: string; branch: string };
/** A live chat in the pull request's worktree, and the name its row shows. */
export type WatchChat = { sessionId: string; name: string };

/** The PR row's watch items: one chat in the worktree reads "this session",
 *  several are named, and none leaves a row that says why it cannot act. */
export function prWatchMenu(
  chats: readonly WatchChat[],
  watches: readonly PrWatchRow[],
  url: string,
  act: { watch: (sessionId: string) => void; unwatch: (sessionId: string) => void },
): MenuItem[] {
  if (chats.length === 0) {
    return [
      { label: "Watch with this session", onClick: () => {}, refusing: true, note: "No chat is open in this worktree" },
    ];
  }
  const watching = (id: string) => watches.some((w) => w.session === id && w.url === url);
  return chats.map((c) => {
    const who = chats.length === 1 ? "this session" : c.name;
    return watching(c.sessionId)
      ? { label: `Stop watching with ${who}`, onClick: () => act.unwatch(c.sessionId) }
      : { label: `Watch with ${who}`, onClick: () => act.watch(c.sessionId) };
  });
}
