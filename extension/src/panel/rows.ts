import type { LogEntry } from "../pick";

export const BODY_CAP = 4096;
const MATCH_MS = 2000;

export type NetRequest = { id: number; finishedAt: number; what: string; status: number | "failed" };

export type Detail = { url: string; request: string | null; response: string | null };

export type DevToolsNetwork = {
  list: () => NetRequest[];
  detail: (id: number) => Promise<Detail | null>;
  listen: (changed: () => void) => () => void;
};

export type Row = { key: string; at: number; entry: LogEntry; requests: NetRequest[]; fromPageLog: boolean };

const textOf = (r: NetRequest) => `${r.what} -> ${r.status}`;

function pageLogRowFor(out: Row[], request: NetRequest): Row | null {
  const text = textOf(request);
  let home: Row | null = null;
  for (const row of out) {
    if (!row.fromPageLog || row.entry.kind !== "request" || row.entry.text !== text) continue;
    if (row.at - MATCH_MS > request.finishedAt || (home && home.at > row.at)) continue;
    home = row;
  }
  return home;
}

export function rows(entries: LogEntry[], requests: NetRequest[]): Row[] {
  const out: Row[] = entries.map((entry) => ({
    key: `log-${entry.seq}`,
    at: entry.at,
    entry,
    requests: [],
    fromPageLog: true,
  }));
  for (const request of requests) {
    const home = pageLogRowFor(out, request);
    if (home) home.requests.push(request);
    else {
      const at = request.finishedAt;
      const entry: LogEntry = { seq: 0, at, kind: "request", text: textOf(request), count: 1, reportable: false };
      out.push({ key: `net-${request.id}`, at, entry, requests: [request], fromPageLog: false });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

const capped = (text: string) => (text.length > BODY_CAP ? `${text.slice(0, BODY_CAP)}...` : text);

export function withDetail(entry: LogEntry, detail: Detail | null): LogEntry {
  if (!detail) return entry;
  const lines = [entry.text, `url: ${detail.url}`];
  if (detail.request) lines.push(`request body: ${capped(detail.request)}`);
  if (detail.response) lines.push(`response body: ${capped(detail.response)}`);
  return { ...entry, text: lines.join("\n") };
}
