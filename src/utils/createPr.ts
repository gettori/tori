// What the "Open PR" button does, decided in one place.
//
// Three outcomes, and the whole point is that they are decided together: an
// authenticated GitHub remote opens a form in-app, anything else falls back to
// the provider's compare page, and an unrecognized origin refuses. Spreading
// that across the button, the dialog, and the submit handler is how a signed-out
// user ends up looking at a form whose submit cannot work.

import { mayUseForge, type AuthState } from "./forgeTypes";
import { canonicalHost, originHost, parseOrigin, type KnownHosts, type Provider } from "./prUrl";

export type PrPath = "form" | "compare" | "none";

/// Whether the forge API can serve this origin at all, regardless of sign-in.
///
/// Stricter than `prUrl`'s name guess on purpose. Rust files an account only
/// after the host's API named the token's login, so a host with one is a host
/// the client reaches; a name containing "github" proves nothing of the kind.
export function apiCanServe(origin: string | null, known: KnownHosts): boolean {
  if (!origin) return false;
  const parsed = parseOrigin(origin, known);
  return parsed !== null && known.has(canonicalHost(parsed.host));
}

/// The providers Rust's `forge_for` has an adapter for. `forgeTypes.test.ts`
/// holds this to the list Rust emits, so the two cannot drift.
export const ADAPTERS: ReadonlySet<Provider> = new Set(["github", "gitlab"]);

/// The host to offer an account for, or null for one that already serves. A
/// host named like a provider with no adapter gets none, since adding its
/// account in Settings would fail.
export function connectHost(origin: string | null, known: KnownHosts): string | null {
  if (!origin || apiCanServe(origin, known)) return null;
  const parsed = parseOrigin(origin, known);
  if (parsed) return ADAPTERS.has(parsed.provider) ? canonicalHost(parsed.host) : null;
  // A name that suggests no provider can still be a GitHub Enterprise server.
  const host = originHost(origin);
  return host ? canonicalHost(host) : null;
}

/// Which of the three paths the button takes.
///
/// `compare` is not a degraded mode to apologise for: it is how every host
/// without an account, every signed-out user, and everyone with the integration
/// switched off opens a PR, and it works without an account.
export function prPath(
  origin: string | null,
  known: KnownHosts,
  auth: AuthState,
  enabled: boolean,
): PrPath {
  if (!origin) return "none";
  if (apiCanServe(origin, known) && mayUseForge(auth, enabled)) return "form";
  return parseOrigin(origin, known) ? "compare" : "none";
}

/// The words the agent is asked to draft in.
///
/// Mirrors the commit-message request rather than inventing a second phrasing,
/// so the two read as the same feature. Names the branch and its base, because
/// a title for "wave-3 into main" is a different sentence from one for
/// "wave-3 into release".
export function composeDraftRequest(branch: string, base: string, paths: string[]): string {
  const files = paths.length ? `: ${paths.join(", ")}` : "";
  return `Draft a pull request title and body for ${branch} against ${base}${files}`;
}

/// Why the form cannot be submitted yet, or null when it can.
///
/// A reason rather than a boolean: a disabled button that never says why reads
/// as a broken control, which is the same rule the panel's capability gate
/// follows.
export function submitBlockedReason(fields: {
  title: string;
  base: string;
  head: string;
  busy: boolean;
}): string | null {
  if (fields.busy) return "Opening…";
  if (!fields.title.trim()) return "A title is required";
  if (!fields.head.trim()) return "No branch to open a PR from";
  if (!fields.base.trim()) return "No base branch";
  // GitHub refuses this with a 422 whose message is easy to miss, and the
  // answer is never "try again": the user has to pick a different base.
  if (fields.base.trim() === fields.head.trim()) return "The base and the branch are the same";
  return null;
}
