import type { ForgeProvider } from "../../../../utils/forgeTypes";

export type Route = "browser" | "token";

export type Cloud = "github.com" | "gitlab.com";
export type SelfHosted = "enterprise" | "self-managed";
export type Product = Cloud | SelfHosted;

export type Target = { provider: ForgeProvider; baseUrl: string; accountId: string | null };

export type Failure =
  | { kind: "denied" | "expired"; code: string }
  | { kind: "error"; message: string; code: string | null };

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

export function begin(target: Target, browser: boolean): AddFlow {
  return browser ? { step: "waiting", route: "browser", target } : { step: "token", route: "token", target };
}

/** `browser` is whether the product's cloud host offers the device flow; a
 *  self-hosted product asks for its URL first either way. */
export function choose(product: Product, browser: boolean): AddFlow {
  if (product === "enterprise" || product === "self-managed") return { step: "host-url", product };
  return begin({ ...CLOUDS[product], accountId: null }, browser);
}

export function hostKnown(product: SelfHosted, baseUrl: string): AddFlow {
  return begin({ provider: SELF_HOSTED[product], baseUrl, accountId: null }, false);
}

export function failed(flow: AddFlow, failure: Failure): AddFlow {
  if (flow.step !== "token" && flow.step !== "waiting") return flow;
  return { step: "error", route: flow.route, target: flow.target, failure };
}

export function startAgain(flow: AddFlow): AddFlow {
  return flow.step === "error" ? begin(flow.target, flow.route === "browser") : flow;
}

/** Token paste works on every host, so only the browser needs `browserOffered`. */
export function otherRoute(flow: AddFlow, browserOffered: boolean): AddFlow {
  if (flow.step !== "error") return flow;
  if (flow.route === "browser") return begin(flow.target, false);
  return browserOffered ? begin(flow.target, true) : flow;
}
