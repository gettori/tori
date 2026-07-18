// Pure helpers for the "Open PR" button (plan: review-to-prompt + commit
// flow, phase 3): derive a provider's new-PR/MR compare URL from the
// `origin` remote URL, normalizing both https and ssh forms. The base
// branch itself comes from the backend's `git_default_base_branch`
// (origin/HEAD with a main/master fallback probe) - this module only turns
// (origin, base, branch) into the compare URL.

export type Provider = "github" | "gitlab" | "bitbucket";

type ParsedOrigin = { provider: Provider; host: string; owner: string; repo: string };

function detectProvider(host: string): Provider | null {
  if (host.includes("github")) return "github";
  if (host.includes("gitlab")) return "gitlab";
  if (host.includes("bitbucket")) return "bitbucket";
  return null;
}

function ownerAndRepo(path: string): { owner: string; repo: string } | null {
  const parts = path
    .replace(/^\/+/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2) return null;
  const repo = parts.pop()!;
  const owner = parts.join("/");
  return { owner, repo };
}

/** Normalize an `origin` remote URL (https, ssh://, or scp-like
 *  `git@host:owner/repo.git`) into its provider, host, owner, and repo.
 *  Returns null for an unrecognized provider or an unparseable URL. */
export function parseOrigin(url: string): ParsedOrigin | null {
  const trimmed = url.trim();

  // scp-like ssh (no "://"): git@host:owner/repo(.git)?
  if (!trimmed.includes("://")) {
    const m = trimmed.match(/^(?:[\w.-]+@)?([\w.-]+):(.+)$/);
    if (!m) return null;
    const provider = detectProvider(m[1]);
    if (!provider) return null;
    const or = ownerAndRepo(m[2]);
    if (!or) return null;
    return { provider, host: m[1], ...or };
  }

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  const provider = detectProvider(u.hostname);
  if (!provider) return null;
  const or = ownerAndRepo(u.pathname);
  if (!or) return null;
  return { provider, host: u.hostname, ...or };
}

/** The provider's new-PR/MR compare URL for `branch` against `base`, or null
 *  when `origin` isn't a recognized provider. Built off the parsed host, so
 *  a self-hosted GitHub Enterprise / GitLab / Bitbucket Server instance gets
 *  its own domain rather than the public one. */
export function comparePrUrl(origin: string, base: string, branch: string): string | null {
  const parsed = parseOrigin(origin);
  if (!parsed) return null;
  const { provider, host, owner, repo } = parsed;
  const b = encodeURIComponent(base);
  const h = encodeURIComponent(branch);
  switch (provider) {
    case "github":
      return `https://${host}/${owner}/${repo}/compare/${b}...${h}?expand=1`;
    case "gitlab":
      return `https://${host}/${owner}/${repo}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${h}&merge_request%5Btarget_branch%5D=${b}`;
    case "bitbucket":
      return `https://${host}/${owner}/${repo}/pull-requests/new?source=${h}&dest=${b}`;
  }
}
