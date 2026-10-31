import { describe, it, expect, vi } from "vite-plus/test";
import { createRoot, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import {
  createRelatedSessions,
  incomingSenders,
  mergeRelated,
  type Lookups,
  type RelationRow,
} from "./relatedSessions";
import type { ChatItem, ToolItem } from "./chatStore";

const handlers: Record<string, () => void> = {};
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: () => void) => {
    handlers[event] = handler;
    return () => {};
  }),
}));
import type { SessionMeta } from "../../utils/sessionStore";

function meta(id: string, cwd: string, name: string, last = 0): SessionMeta {
  return { id, path: "", cwd, branch: "main", title: name, last_active: last, created_at: 0, name };
}

const SESSIONS: Record<string, SessionMeta> = {
  parent: meta("parent", "/w/api/main", "Fix the login flow", 5),
  peer: meta("peer", "/w/web/main", "Docs refresh", 9),
};

const look: Lookups = {
  session: (id) => SESSIONS[id],
  dot: (id) => (id === "peer" ? "working" : "solid"),
  unit: (folder) =>
    folder.startsWith("/w/web") ? { projectPath: "/w/web", branch: "main" } : { projectPath: "/w/api", branch: "main" },
};

const steer = (id: string, from: string): ChatItem => ({
  kind: "user",
  id,
  blocks: [{ type: "text", text: `<tori kind="steer" from="${from}">\nhi\n</tori>` }],
  steer: false,
});

describe("mergeRelated", () => {
  it("adds who prompted this chat to what the backend knows, once each", () => {
    const rows: RelationRow[] = [{ id: "parent", side: "from", relation: "spawned", cwd: "/w/api/main" }];
    const merged = mergeRelated(
      rows,
      incomingSenders([steer("u1", "peer"), steer("u2", "peer"), steer("u3", "parent")]),
      look,
    );
    expect(merged.map((m) => [m.id, m.side, m.relation])).toEqual([
      ["parent", "from", "spawned"],
      ["peer", "from", "prompted"],
    ]);
  });

  it("names a related session in another project, with its project and state", () => {
    const [peer] = mergeRelated([{ id: "peer", side: "to", relation: "linked", cwd: "/w/web/main" }], [], look);
    expect(peer).toMatchObject({ name: "Docs refresh", project: "web", branch: "main", state: "working", lastAt: 9 });
  });
});

describe("createRelatedSessions", () => {
  const tool = (id: string, name: string): ToolItem =>
    ({ kind: "tool", id, name, title: null, input: {}, state: "ok" }) as unknown as ToolItem;
  const asked = () => vi.mocked(invoke).mock.calls.filter(([c]) => c === "session_relations").length;
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("asks again when a link changes or a tie-making call finishes, not for any tool", async () => {
    const [items, setItems] = createSignal<ChatItem[]>([]);
    const dispose = createRoot((dispose) => {
      createRelatedSessions(() => "me", items, look)();
      return dispose;
    });
    await settle();
    const first = asked();

    setItems([tool("t1", "Bash")]);
    await settle();
    expect(asked()).toBe(first);

    setItems([tool("t1", "Bash"), tool("t2", "mcp__tori__session_spawn")]);
    await settle();
    expect(asked()).toBe(first + 1);

    handlers["links://changed"]();
    await settle();
    expect(asked()).toBe(first + 2);
    dispose();
  });
});
