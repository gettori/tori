import { describe, it, expect } from "vitest";
import { begin, choose, failed, hostKnown, otherRoute, startAgain, type AddFlow, type Target } from "./forgeAddFlow";

const github: Target = { provider: "github", baseUrl: "https://github.com", accountId: null };
const gitlab: Target = { provider: "gitlab", baseUrl: "https://gitlab.com", accountId: null };
const refused = { kind: "error", message: "github.com rejected that token.", code: "invalid" } as const;

describe("the add flow", () => {
  it("sends github.com straight to the browser", () => {
    expect(choose("github.com", true)).toEqual({ step: "waiting", route: "browser", target: github });
  });

  it("sends gitlab.com to a token, or to the browser once the host has an application id", () => {
    expect(choose("gitlab.com", false)).toEqual({ step: "token", route: "token", target: gitlab });
    expect(choose("gitlab.com", true)).toEqual({ step: "waiting", route: "browser", target: gitlab });
  });

  it("asks a self-hosted product for its URL, then for a token", () => {
    expect(choose("enterprise", true)).toEqual({ step: "host-url", product: "enterprise" });
    expect(choose("self-managed", false)).toEqual({ step: "host-url", product: "self-managed" });

    const target = { provider: "gitlab", baseUrl: "https://git.acme.dev", accountId: null };
    expect(hostKnown("self-managed", "https://git.acme.dev")).toEqual({ step: "token", route: "token", target });
    expect(hostKnown("enterprise", "https://ghe.acme.dev")).toMatchObject({ target: { provider: "github" } });
  });

  it("keeps the account being signed in again through every step", () => {
    const again = { ...github, accountId: "github-com-skarif2" };
    const flow = failed(begin(again, true), { kind: "expired", code: "expired_token" });
    expect(startAgain(flow)).toEqual({ step: "waiting", route: "browser", target: again });
    expect(otherRoute(flow, true)).toEqual({ step: "token", route: "token", target: again });
  });

  it("fails a refused token on the token route", () => {
    const flow = failed(begin(github, false), refused);
    expect(flow).toMatchObject({ step: "error", route: "token", failure: { kind: "error" } });
  });

  it("fails a denied or expired code on the browser route", () => {
    for (const kind of ["denied", "expired"] as const) {
      const flow = failed(begin(github, true), { kind, code: kind === "denied" ? "access_denied" : "expired_token" });
      expect(flow).toMatchObject({ step: "error", route: "browser", failure: { kind } });
    }
  });

  it("starts the failing route again", () => {
    const token = failed(begin(github, false), refused);
    const browser = failed(begin(github, true), { kind: "denied", code: "access_denied" });
    expect(startAgain(token)).toEqual(begin(github, false));
    expect(startAgain(browser)).toEqual(begin(github, true));
  });

  it("crosses to the other route, and to the browser only where the host offers one", () => {
    const token = failed(begin(github, false), refused);
    const browser = failed(begin(github, true), { kind: "denied", code: "access_denied" });
    expect(otherRoute(browser, false)).toEqual(begin(github, false));
    expect(otherRoute(token, true)).toEqual(begin(github, true));
    expect(otherRoute(token, false)).toBe(token);
  });

  it("changes nothing when a step has no such transition", () => {
    const picker: AddFlow = { step: "product" };
    expect(failed(picker, { kind: "denied", code: "access_denied" })).toBe(picker);
    expect(startAgain(picker)).toBe(picker);
    expect(otherRoute(picker, true)).toBe(picker);
  });
});
