import type { ForgeProvider, SignInStart } from "../../../../utils/forgeTypes";

export type Route = "browser" | "token";

export type Cloud = "github.com" | "gitlab.com";
export type SelfHosted = "enterprise" | "self-managed";
export type Product = Cloud | SelfHosted;

export type Target = { provider: ForgeProvider; baseUrl: string; accountId: string | null };

export type Failure =
  | { kind: "denied" | "expired"; code: string }
  | { kind: "error"; message: string; code: string | null }
  /// Not a failure of the host's, but of the surface: first run has no token
  /// field, so a host whose only route is a token has to say where that is.
  | { kind: "needsToken"; host: string };

export type AddFlow =
  | { step: "product" }
  | { step: "host-url"; product: SelfHosted }
  | { step: "token"; route: "token"; target: Target }
  | { step: "waiting"; route: "browser"; target: Target }
  | { step: "error"; route: Route; target: Target; failure: Failure };

export const CLOUDS: Record<Cloud, { provider: ForgeProvider; baseUrl: string }> = {
  "github.com": { provider: "github", baseUrl: "https://github.com" },
  "gitlab.com": { provider: "gitlab", baseUrl: "https://gitlab.com" },
};

export const SELF_HOSTED: Record<SelfHosted, ForgeProvider> = { enterprise: "github", "self-managed": "gitlab" };

export const isSelfHosted = (product: Product): product is SelfHosted =>
  product === "enterprise" || product === "self-managed";

/** Which card the host's one sign-in button lands on. `null` is a sign-in that
 *  is already finished, which is what reading the user's `gh` login gives. */
export function began(target: Target, start: SignInStart): AddFlow | null {
  switch (start.kind) {
    case "signedIn":
      return null;
    case "browser":
      return { step: "waiting", route: "browser", target };
    case "token":
      return { step: "token", route: "token", target };
  }
}

export function failed(flow: AddFlow, failure: Failure): AddFlow {
  if (flow.step !== "token" && flow.step !== "waiting") return flow;
  return { step: "error", route: flow.route, target: flow.target, failure };
}

/** The one way out of a failed browser sign-in. There is no reverse: a token is
 *  the route Rust falls back to on its own, so "browser instead" would offer
 *  something it already declined to do. */
export function pasteInstead(flow: AddFlow): AddFlow {
  if (flow.step !== "error" || flow.route !== "browser") return flow;
  return { step: "token", route: "token", target: flow.target };
}
