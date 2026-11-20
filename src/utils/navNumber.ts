// Mirrors `split_key` and `candidates` in src-tauri/src/issues/mod.rs, so a
// number typed here names the issue the lookup would find.

/** An issue or pull request as a repo (`owner/name`, lowercased) and a number.
 *  `repo` is null when the project's origin is not known. */
export type IssueId = { repo: string | null; number: number };

/** A typed issue or pull request number. `repo` is set by `owner/name#N` and
 *  by a URL, `name` by `name#N`, and neither by `N` or `#N`. */
export type NumberQuery = { repo: string | null; name: string | null; digits: string };

const URL_FORM = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+?)(?:\/-)?\/(?:issues|pull|merge_requests)\/(\d+)\/?$/i;

function splitKey(key: string): { repo: string; number: string } | null {
  const url = URL_FORM.exec(key);
  if (url) return url[1].includes("/") ? { repo: url[1].toLowerCase(), number: url[2] } : null;
  const at = key.lastIndexOf("#");
  if (at < 0) return null;
  const repo = key.slice(0, at);
  const number = key.slice(at + 1);
  return /^\d+$/.test(number) && repo.includes("/") && !/\s/.test(repo) ? { repo: repo.toLowerCase(), number } : null;
}

/** What a typed word asks for when it is a number search, else null. */
export function numberQuery(word: string): NumberQuery | null {
  const w = word.trim();
  const bare = /^#?(\d+)$/.exec(w);
  if (bare) return { repo: null, name: null, digits: bare[1] };
  const split = splitKey(w);
  if (split) return { repo: split.repo, name: null, digits: split.number };
  const named = /^([\w.-]+)#(\d+)$/.exec(w);
  return named ? { repo: null, name: named[1].toLowerCase(), digits: named[2] } : null;
}

/** A stored issue key as a repo and a number. A bare key is the project's
 *  own, so it takes `origin`, else the repo its URL names. */
export function issueId(issue: { key: string; url: string }, origin: string | null): IssueId | null {
  const bare = /^#?(\d+)$/.exec(issue.key.trim());
  if (bare) return { repo: origin ?? splitKey(issue.url)?.repo ?? null, number: Number(bare[1]) };
  const split = splitKey(issue.key.trim());
  return split ? { repo: split.repo, number: Number(split.number) } : null;
}

/** How a ticket chip reads: `#N` for the project's own repo, `name#N` for any
 *  other. A key that is not a number keeps its own spelling. */
export function ticketLabel(issue: { key: string; display: string }): string {
  const key = issue.key.trim();
  if (/^\d+$/.test(key)) return `#${key}`;
  const split = splitKey(key);
  return split ? `${split.repo.split("/").pop()}#${split.number}` : issue.display;
}

/** Whether `query` names this number: a typed repo must be the number's own and
 *  a typed name its repo's name. The digits are the whole number or a run
 *  inside it, never scattered through it. */
export function numberHit(query: NumberQuery, id: IssueId): { exact: boolean; digitsAt: number } | null {
  if (query.repo && query.repo !== id.repo) return null;
  if (query.name && id.repo?.split("/").pop() !== query.name) return null;
  const digits = String(id.number);
  const at = digits.indexOf(query.digits);
  return at < 0 ? null : { exact: digits === query.digits, digitsAt: at };
}

/** A pasted absolute path inside one of `folders`: the deepest one holding it,
 *  and the line a `:line` or `:line:col` after it names. */
export type PathQuery = { folder: string; path: string; rel: string; line?: number };

const bare = (path: string) => path.replace(/\/+$/, "");

/** What a pasted path opens, or null when no folder holds it. */
export function pathQuery(raw: string, folders: readonly string[]): PathQuery | null {
  const m = /^(\/.*?)(?::(\d+)(?::\d+)?)?$/.exec(raw.trim());
  if (!m) return null;
  const path = bare(m[1]);
  let folder: string | null = null;
  for (const f of folders) {
    const root = bare(f);
    if ((path === root || path.startsWith(`${root}/`)) && (folder === null || root.length > bare(folder).length))
      folder = f;
  }
  if (folder === null) return null;
  return { folder, path, rel: path.slice(bare(folder).length + 1), line: Number(m[2]) || undefined };
}

/** The port a typed `localhost:<port>` names, with or without a scheme or a path after it. */
export function portQuery(raw: string): number | null {
  const m = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})(?:\/\S*)?$/i.exec(raw.trim());
  const port = m ? Number(m[1]) : 0;
  return port > 0 && port < 65536 ? port : null;
}
