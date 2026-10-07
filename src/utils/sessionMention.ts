import type { ContentBlock } from "./chatTypes";
import type { SessionMeta } from "./sessionStore";

/** What a session is called: the user's own name for it over its title. */
export function sessionTitle(s: Pick<SessionMeta, "name" | "title">): string {
  return (s.name || s.title).replace(/[[\]]/g, "").replace(/\s+/g, " ").trim() || "untitled";
}

/** `[Session: title]`, with ` (2)` and up when `taken` already holds that
 *  label for a different session, so one message never names two by one token. */
export function sessionLabel(title: string, taken: ReadonlyMap<string, string>, id: string): string {
  const base = `[Session: ${title}`;
  for (let n = 1; ; n++) {
    const label = n === 1 ? `${base}]` : `${base} (${n})]`;
    const owner = taken.get(label);
    if (owner === undefined || owner === id) return label;
  }
}

export function sessionRef(s: SessionMeta, label: string, project: string): ContentBlock {
  return {
    type: "ref",
    label,
    target: { kind: "session", id: s.id, title: sessionTitle(s), agent: s.agent ?? "claude", project },
  };
}
