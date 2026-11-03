// Chats: sessions with no project, run in a folder Tori owns (`chats/<id>`).
// Every session spawned there (the first send, forks, rewinds, handoffs) keeps
// that cwd, so the folder is the chat and its newest session names the row.
import { createMemo, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { Selection } from "../panels/LeftSidebar/LeftSidebar";
import { sessions, trackFolders, type SessionMeta } from "./sessionStore";
import { GLOBAL_KEY } from "./globalSpace";
import { asTabProfile } from "./agentHealth";

export const NEW_CHAT_NAME = "New chat";

export type Chat = {
  id: string;
  folder: string;
  /** Newest first. Empty for a chat made this run and not yet sent to. */
  sessions: SessionMeta[];
  /** Null until the newest session has a title. */
  name: string | null;
  updated: number;
};

const [root, setRoot] = createSignal<string | null>(null);
export const chatsRoot = root;

export async function ensureChatsRoot(): Promise<string | null> {
  if (!root()) setRoot(await invoke<string>("chats_root").catch(() => null));
  const r = root();
  if (r) void trackFolders([r], { inclusive: true });
  return r;
}

// A chat whose folder exists but whose first send has not landed yet: nothing
// lists it, so the row is kept from here until a session shows up.
const [fresh, setFresh] = createSignal<Record<string, { folder: string; at: number }>>({});

export function chatIdOf(cwd: string, chatsRoot: string): string | null {
  const base = chatsRoot.replace(/\/+$/, "");
  if (!cwd.startsWith(`${base}/`)) return null;
  return cwd.slice(base.length + 1).split("/")[0] || null;
}

export function groupChats(
  list: readonly SessionMeta[],
  chatsRoot: string,
  pending: Record<string, { folder: string; at: number }>,
): Chat[] {
  const base = chatsRoot.replace(/\/+$/, "");
  const byId = new Map<string, SessionMeta[]>();
  for (const s of list) {
    const id = chatIdOf(s.cwd, chatsRoot);
    if (id) byId.set(id, [...(byId.get(id) ?? []), s]);
  }
  const out: Chat[] = [];
  for (const [id, rows] of byId) {
    const sorted = [...rows].sort((a, b) => b.last_active - a.last_active);
    const newest = sorted[0];
    out.push({
      id,
      folder: `${base}/${id}`,
      sessions: sorted,
      name: newest.name || newest.title || null,
      updated: newest.last_active,
    });
  }
  for (const [id, p] of Object.entries(pending)) {
    if (!byId.has(id)) out.push({ id, folder: p.folder, sessions: [], name: null, updated: p.at });
  }
  return out.sort((a, b) => b.updated - a.updated);
}

const sameChat = (a: Chat, b: Chat) =>
  a.folder === b.folder &&
  a.name === b.name &&
  a.updated === b.updated &&
  a.sessions.length === b.sessions.length &&
  a.sessions.every((s, i) => s === b.sessions[i]);

// One object per chat across recomputes while it is unchanged, so a list keyed
// on the objects does not rebuild a row under the pointer on every refresh.
let kept = new Map<string, Chat>();

export const chats = createMemo(() => {
  const r = root();
  const next = (r ? groupChats(sessions()[r] ?? [], r, fresh()) : []).map((c) => {
    const prior = kept.get(c.id);
    return prior && sameChat(prior, c) ? prior : c;
  });
  kept = new Map(next.map((c) => [c.id, c]));
  return next;
});

export function chatById(id: string | null | undefined): Chat | null {
  return (id && chats().find((c) => c.id === id)) || null;
}

export async function newChat(): Promise<Chat> {
  await ensureChatsRoot();
  const made = await invoke<{ id: string; folder: string }>("chat_new");
  const at = Date.now();
  setFresh((m) => ({ ...m, [made.id]: { folder: made.folder, at } }));
  return { id: made.id, folder: made.folder, sessions: [], name: null, updated: at };
}

export function forgetChat(id: string) {
  setFresh(({ [id]: _, ...rest }) => rest);
}

export function chatSelection(chat: Pick<Chat, "id" | "folder" | "name">, session?: SessionMeta): Selection {
  return {
    kind: "chat",
    chatId: chat.id,
    spaceName: GLOBAL_KEY,
    projectName: chat.name ?? NEW_CHAT_NAME,
    projectPath: chat.folder,
    folderPath: chat.folder,
    branch: "",
    projectKind: "chat",
    profile: asTabProfile(session?.profile),
    ...(session && {
      agent: session.agent,
      sessionId: session.id,
      sessionPath: session.path,
      sessionFile: session.path,
      sessionCwd: session.cwd,
      sessionTitle: session.title,
      sessionName: session.name,
    }),
  };
}

const HOUR = 3_600_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const OLDER_AFTER = 7 * 24 * HOUR;

export function chatTime(at: number, now: number): string {
  const ago = now - at;
  if (ago < HOUR) return "now";
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((day(now) - day(at)) / (24 * HOUR));
  if (days <= 0) return `${Math.floor(ago / HOUR)}h`;
  if (days === 1) return "Yesterday";
  const d = new Date(at);
  if (days < 7) return DAYS[d.getDay()];
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
