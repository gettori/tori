// Pure helpers for the "Open PR" button (plan: review-to-prompt + commit
// flow, phase 3): derive a provider's new-PR/MR compare URL from the
// `origin` remote URL, normalizing both https and ssh forms. The base
// branch itself comes from the backend's `git_default_base_branch`
// (origin/HEAD with a main/master fallback probe) - this module only turns
// (origin, base, branch) into the compare URL.

import type { ForgeProvider } from "./forgeTypes";

export type Provider = "github" | "gitlab" | "bitbucket";

export type KnownHosts = ReadonlyMap<string, { provider: ForgeProvider; baseUrl: string }>;

type OriginParts = { host: string; owner: string; repo: string };
type ParsedOrigin = OriginParts & { provider: Provider };

/** A host spelled the way Rust keys account hosts. */
export function canonicalHost(host: string): string {
  const lower = host.toLowerCase();
  return lower === "www.github.com" ? "github.com" : lower;
}

function detectProvider(host: string, known: KnownHosts): Provider | null {
  const registered = known.get(canonicalHost(host));
  if (registered) return registered.provider;
  // No account on the host, so its name is the only hint. Good enough for a
  // compare URL, which is all an unregistered host gets.
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

function originParts(url: string): OriginParts | null {
  const trimmed = url.trim();

  // scp-like ssh (no "://"): git@host:owner/repo(.git)?
  if (!trimmed.includes("://")) {
    const m = trimmed.match(/^(?:[\w.-]+@)?([\w.-]+):(.+)$/);
    if (!m) return null;
    const or = ownerAndRepo(m[2]);
    return or ? { host: m[1], ...or } : null;
  }

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  const or = ownerAndRepo(u.pathname);
  return or ? { host: u.hostname, ...or } : null;
}

/** The host of an `origin` remote URL, whether or not any provider is
 *  recognized there. Null for an unparseable URL. */
export function originHost(url: string): string | null {
  return originParts(url)?.host ?? null;
}

/** Normalize an `origin` remote URL (https, ssh://, or scp-like
 *  `git@host:owner/repo.git`) into its provider, host, owner, and repo.
 *  Returns null for an unrecognized provider or an unparseable URL. */
export function parseOrigin(url: string, known: KnownHosts): ParsedOrigin | null {
  const parts = originParts(url);
  const provider = parts && detectProvider(parts.host, known);
  return parts && provider ? { provider, ...parts } : null;
}

/** The provider's new-PR/MR compare URL for `branch` against `base`, or null
 *  when `origin` isn't a recognized provider. A host with an account is
 *  reached at its account's base URL, which keeps a port the ssh remote
 *  cannot carry; any other host is assumed to serve https on its own name. */
export function comparePrUrl(
  origin: string,
  base: string,
  branch: string,
  known: KnownHosts,
): string | null {
  const parsed = parseOrigin(origin, known);
  if (!parsed) return null;
  const { provider, host, owner, repo } = parsed;
  const web = known.get(canonicalHost(host))?.baseUrl ?? `https://${host}`;
  const b = encodeURIComponent(base);
  const h = encodeURIComponent(branch);
  switch (provider) {
    case "github":
      return `${web}/${owner}/${repo}/compare/${b}...${h}?expand=1`;
    case "gitlab":
      return `${web}/${owner}/${repo}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${h}&merge_request%5Btarget_branch%5D=${b}`;
    case "bitbucket":
      return `${web}/${owner}/${repo}/pull-requests/new?source=${h}&dest=${b}`;
  }
}
