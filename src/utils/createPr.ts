// What the "Open PR" button does, decided in one place.
//
// Three outcomes, and the whole point is that they are decided together: an
// authenticated GitHub remote opens a form in-app, anything else falls back to
// the provider's compare page, and an unrecognized origin refuses. Spreading
// that across the button, the dialog, and the submit handler is how a signed-out
// user ends up looking at a form whose submit cannot work.

import { mayUseForge, type AuthState } from "./forgeTypes";
import { parseOrigin } from "./prUrl";

export type PrPath = "form" | "compare" | "none";

/// The hosts the API client actually speaks to.
///
/// Deliberately stricter than `prUrl`'s provider detection, which matches any
/// host *containing* "github" so that GitHub Enterprise still gets a working
/// compare URL. The Rust resolver (`forge::commands::client_for`) serves only
/// github.com so far, so a GHE remote passing the looser test would open a form whose
/// submit comes back `unsupportedRemote`. Compare still works there; the form
/// does not.
const API_HOSTS = ["github.com", "www.github.com"];

/// Whether the forge API can serve this origin at all, regardless of sign-in.
export function apiCanServe(origin: string | null): boolean {
  if (!origin) return false;
  const parsed = parseOrigin(origin);
  if (!parsed) return false;
  return parsed.provider === "github" && API_HOSTS.includes(parsed.host.toLowerCase());
}

/// Which of the three paths the button takes.
///
/// `compare` is not a degraded mode to apologise for: it is how every non-GitHub
/// remote, every signed-out user, and everyone with the integration switched off
/// opens a PR, and it works without an account.
export function prPath(origin: string | null, auth: AuthState, enabled: boolean): PrPath {
  if (!origin) return "none";
  if (apiCanServe(origin) && mayUseForge(auth, enabled)) return "form";
  return parseOrigin(origin) ? "compare" : "none";
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
