/// What to say, and what to offer, when a GitHub organisation has not approved
/// the application behind an account's token.
///
/// One decision shared by every surface that meets it. The sidebar's repo row
/// discovers it from a `404` on a poll, and the sign-in surfaces from the same
/// refusal on a repo the user just opened; a second copy of the rule would let
/// the two offer different routes out of the identical problem.
///
/// The offer is always **the route not yet tried**. An organisation refuses an
/// OAuth application, not a person: Tori's own application is what it blocked,
/// so a fresh browser sign-in through that same application changes nothing.
/// What does change something is a credential minted elsewhere, and there are
/// exactly two of those.
import type { ForgeSource } from "./forgeTypes";

export type OrgRoute = "cli" | "token";

export type OrgNotice = {
  org: string;
  route: OrgRoute;
  /// One sentence naming the organisation, for the row.
  message: string;
  /// The action's own words, short enough for a button.
  action: string;
};

/// Which credential is worth trying next, given where the current one came from.
///
/// `gh`'s own application was approved by most organisations years ago, so it is
/// the first choice wherever it exists. An account already reading `gh` has
/// spent that option, and so has a machine with no `gh` on it: both are left
/// with a token the user makes by hand, which an organisation cannot refuse
/// because no application stands behind it.
export function orgRoute(source: ForgeSource | null, cliInstalled: boolean): OrgRoute {
  return cliInstalled && source !== "cli" ? "cli" : "token";
}

export function orgNotice(
  org: string,
  source: ForgeSource | null,
  cliInstalled: boolean,
): OrgNotice {
  const route = orgRoute(source, cliInstalled);
  return {
    org,
    route,
    message: `${org} has not approved Tori.`,
    action: route === "cli" ? "Sign in with GitHub CLI" : "Paste a classic token",
  };
}
