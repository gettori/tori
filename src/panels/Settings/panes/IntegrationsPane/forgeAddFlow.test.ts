import { describe, it, expect } from "vitest";
import { began, failed, isSelfHosted, pasteInstead, type AddFlow, type Target } from "./forgeAddFlow";
import type { SignInRoutes, SignInStart } from "../../../../utils/forgeTypes";

const github: Target = { provider: "github", baseUrl: "https://github.com", accountId: null };
const refused = { kind: "error", message: "github.com rejected that token.", code: "invalid" } as const;

const routes: SignInRoutes = {
  host: "github.com",
  baseUrl: "https://github.com",
  deviceFlow: false,
  scopes: ["repo", "workflow"],
  tokenUrl: "https://github.com/settings/tokens/new",
  appId: null,
};
const asToken: SignInStart = { kind: "token", routes };
const asBrowser: SignInStart = {
  kind: "browser",
  routes: { ...routes, deviceFlow: true },
  prompt: { userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresInSecs: 900, intervalSecs: 5 },
};

describe("the add flow", () => {
  it("renders whichever route Rust took, and nothing at all when gh already answered", () => {
    expect(began(github, asToken)).toEqual({ step: "token", route: "token", target: github });
    expect(began(github, asBrowser)).toEqual({ step: "waiting", route: "browser", target: github });
    expect(began(github, { kind: "signedIn", accountId: "github-com-skarif2", login: "skarif2" })).toBeNull();
  });

  it("knows which products need a host URL first", () => {
    expect(isSelfHosted("enterprise")).toBe(true);
    expect(isSelfHosted("self-managed")).toBe(true);
    expect(isSelfHosted("github.com")).toBe(false);
  });

  it("keeps the account being signed in again through every step", () => {
    const again = { ...github, accountId: "github-com-skarif2" };
    const flow = failed(began(again, asBrowser)!, { kind: "expired", code: "expired_token" });
    expect(pasteInstead(flow)).toEqual({ step: "token", route: "token", target: again });
  });

  it("fails a refused token on the token route", () => {
    const flow = failed(began(github, asToken)!, refused);
    expect(flow).toMatchObject({ step: "error", route: "token", failure: { kind: "error" } });
  });

  it("fails a denied or expired code on the browser route", () => {
    for (const kind of ["denied", "expired"] as const) {
      const start = failed(began(github, asBrowser)!, { kind, code: kind === "denied" ? "access_denied" : "expired_token" });
      expect(start).toMatchObject({ step: "error", route: "browser", failure: { kind } });
    }
  });

  it("offers a token only out of a failed browser sign-in", () => {
    // There is no reverse: a token is what Rust already falls back to on its
    // own, so a failed token step has nowhere else to go.
    const token = failed(began(github, asToken)!, refused);
    expect(pasteInstead(token)).toBe(token);
  });

  it("changes nothing when a step has no such transition", () => {
    const picker: AddFlow = { step: "product" };
    expect(failed(picker, { kind: "denied", code: "access_denied" })).toBe(picker);
    expect(pasteInstead(picker)).toBe(picker);
  });
});
