import { describe, it, expect } from "vitest";
import { orgNotice, orgRoute } from "./orgNotice";

// The rule both surfaces share. The sidebar's repo row meets this on a poll and
// the sign-in surfaces meet it on a repo the user just opened, and the two
// offering different ways out of the same refusal is exactly what one helper
// exists to prevent.

describe("what to offer when an organisation has not approved Tori", () => {
  it("sends a pasted or browser token to gh, whose application the org already allows", () => {
    // The refusal is of an application, not of a person, so signing in again
    // through Tori's own application would be refused identically.
    expect(orgRoute("token", true)).toBe("cli");
    expect(orgRoute("browser", true)).toBe("cli");
  });

  it("sends an account already reading gh to a token, the one route left", () => {
    expect(orgRoute("cli", true)).toBe("token");
  });

  it("sends anyone without gh to a token, since there is nothing to offer instead", () => {
    for (const source of ["token", "browser", "cli", null] as const) {
      expect(orgRoute(source, false)).toBe("token");
    }
  });

  it("names the organisation in the sentence and the route in the button", () => {
    expect(orgNotice("acme", "token", true)).toEqual({
      org: "acme",
      route: "cli",
      message: "acme has not approved Tori.",
      action: "Sign in with GitHub CLI",
    });
    expect(orgNotice("globex", "cli", true).action).toBe("Paste a classic token");
  });
});
