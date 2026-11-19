import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { IssueId } from "./navNumber";

// Mirrors `Mention` in src-tauri/src/session_issues.rs.
export type Mention = { owner: string; repo: string; number: number };

const LS_DISMISSED = "tori.mentionsDismissed";
const KEEP_DISMISSED = 500;

const [mentions, setMentions] = createSignal<Readonly<Record<string, readonly Mention[]>>>({});

function loadDismissed(): Set<string> {
  try {
    const keys = JSON.parse(localStorage.getItem(LS_DISMISSED) ?? "[]");
    return new Set(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(loadDismissed());

const dismissKey = (session: string, m: Mention) => `${session} ${m.owner}/${m.repo}#${m.number}`;

export const mentionId = (m: Mention): IssueId => ({ repo: `${m.owner}/${m.repo}`, number: m.number });

export function mentionsOf(session: string): readonly Mention[] {
  return mentions()[session] ?? [];
}

export function offeredMention(session: string): Mention | null {
  const gone = dismissed();
  const list = mentionsOf(session);
  for (let i = list.length - 1; i >= 0; i--) if (!gone.has(dismissKey(session, list[i]))) return list[i];
  return null;
}

export function dismissMention(session: string, m: Mention) {
  const next = new Set([...dismissed(), dismissKey(session, m)].slice(-KEEP_DISMISSED));
  setDismissed(next);
  try {
    localStorage.setItem(LS_DISMISSED, JSON.stringify([...next]));
  } catch {
    // ignore quota
  }
}

// An earlier read that answers late must not land over a newer one.
let seq = 0;
async function read() {
  const mine = ++seq;
  const all = await invoke<Record<string, Mention[]> | null>("session_issues_list").catch(() => null);
  if (mine === seq && all) setMentions(all);
}

export function watchSessionIssues(): () => void {
  void read();
  let stopped = false;
  let unlisten: (() => void) | undefined;
  void listen("mentions://changed", () => void read()).then((off) => {
    if (stopped) off();
    else unlisten = off;
  });
  return () => {
    stopped = true;
    unlisten?.();
  };
}
